import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import { Nas } from '../nas.js';
import { Cloudflare, type TunnelSummary } from '../cloudflare.js';
import { saveConfig, defaultNas, type HosterConfig } from '../config.js';
import { ask, askHidden } from '../prompt.js';
import { shQuote, substitutePlaceholders } from '../shell.js';
import { ProgressReporter, defaultProgressIo, type ProgressIo } from '../progress.js';

export interface InitInput {
  baseDomain: string;
  nas: { host: string; port: number; user: string };
}

export type InitActionKind = 'nas-exec' | 'nas-transfer' | 'local-exec' | 'cf-api' | 'write-config';

export interface InitAction {
  kind: InitActionKind;
  description: string;
  command?: string;
  method?: string;
  args?: unknown[];
  // 내부 식별자 — 특정 액션(네트워크 이미 존재/외부 통신 진단/healthz 재시도/env 작성)의
  // 실행 시 분기 처리에 쓰인다. description 문자열 매칭보다 안정적이라 별도 필드로 둔다.
  // ssh-docker-precheck/compose-check는 실행 분기가 필요해서가 아니라(둘 다 기본 처리로
  // 충분함), doctor(ops.ts)가 이 두 액션을 설명 문자열 매칭이나 "id 없는 유일한 액션"
  // 같은 취약한 방식이 아니라 안정적인 id로 재사용하기 위한 마커다.
  id?:
    | 'network-create'
    | 'network-diagnostic'
    | 'healthz-check'
    | 'env-write'
    | 'ssh-docker-precheck'
    | 'compose-check';
}

const HOSTER_NET_CREATE_CMD = 'sudo -n /usr/local/bin/docker network create hoster-net';
// tar -C <dir> -xf - 는 대상 디렉터리가 미리 존재해야 하므로 hoster-tmp도 함께 만든다.
const STATE_DIR_CMD = 'mkdir -p /volume1/docker/hoster/state/env /volume1/docker/hoster-tmp';
const REMOTE_STACK_DIR = '/volume1/docker/hoster';
const REMOTE_TMP_DIR = '/volume1/docker/hoster-tmp';

// 순수 함수 — I/O 없음. dry-run 출력 및 실행 계획 검증에 그대로 사용된다.
// 시크릿(TUNNEL_TOKEN/HMAC_SECRET/GHCR_PAT)은 InitInput에 존재하지 않으므로 이 함수의
// 결과물에는 절대 실제 시크릿 값이 섞이지 않는다 — 커맨드 문자열에는 ${...} 플레이스홀더만
// 남기고, 실제 치환은 runInit이 실행 시점에 수행한다.
export function planInit(input: InitInput): InitAction[] {
  const { baseDomain, nas } = input;
  // CARRY-OVER (리뷰 지시): "보간되는 모든 값은 shQuote를 거친다"는 불변식에 예외를
  // 두지 않는다 — NAS host/user/port도 예외가 아니다.
  const sshTarget = shQuote(`${nas.user}@${nas.host}`);
  const sshPrefix = `ssh -p ${shQuote(String(nas.port))} ${sshTarget}`;

  const envWriteCmd =
    "printf 'TUNNEL_TOKEN=%s\\nHMAC_SECRET=%s\\nGHCR_PAT=%s\\nBASE_DOMAIN=%s\\n' " +
    `\${TUNNEL_TOKEN} \${HMAC_SECRET} \${GHCR_PAT} ${shQuote(baseDomain)} > ${REMOTE_STACK_DIR}/.env && ` +
    `chmod 600 ${REMOTE_STACK_DIR}/.env`;
  const composeUpCmd = `cd ${REMOTE_STACK_DIR} && sudo -n /usr/local/bin/docker compose --env-file .env up -d`;

  return [
    {
      kind: 'local-exec',
      description: 'NAS 접속 및 docker 권한 사전 점검',
      command: `${sshPrefix} ${shQuote('sudo -n /usr/local/bin/docker version --format {{.Server.Version}}')}`,
      id: 'ssh-docker-precheck',
    },
    {
      kind: 'nas-exec',
      description: 'docker compose 플러그인 확인',
      command: 'sudo -n /usr/local/bin/docker compose version',
      id: 'compose-check',
    },
    {
      kind: 'cf-api',
      description: "Cloudflare 터널 'hoster' 생성 (같은 이름이 이미 있으면 재사용/삭제를 물어봄)",
      method: 'createTunnel',
      args: ['hoster'],
    },
    {
      kind: 'cf-api',
      description: '터널 인그레스 설정 (hoster.<domain>, *.<domain> 라우팅)',
      method: 'setTunnelIngress',
      args: [
        '${TUNNEL_ID}',
        [
          { hostname: `hoster.${baseDomain}`, service: 'http://hoster-deployer:8080' },
          { hostname: `*.${baseDomain}`, service: 'http://hoster-traefik:80' },
        ],
      ],
    },
    {
      kind: 'cf-api',
      description: `DNS CNAME 설정 (hoster.${baseDomain} → 터널)`,
      method: 'upsertDnsCname',
      args: [`hoster.${baseDomain}`, '${TUNNEL_ID}.cfargotunnel.com'],
    },
    {
      kind: 'nas-exec',
      description: 'hoster-net 네트워크 생성 (이미 있으면 무시)',
      command: HOSTER_NET_CREATE_CMD,
      id: 'network-create',
    },
    {
      kind: 'nas-transfer',
      description: `NAS 상태 디렉터리 준비(${STATE_DIR_CMD}) 및 stack 디렉터리 전송 (docker-compose.yml)`,
    },
    {
      kind: 'local-exec',
      description: 'deployer 이미지 빌드(linux/amd64) 후 NAS로 전송',
      command:
        'docker buildx build --platform linux/amd64 -f packages/deployer/Dockerfile -t hoster-deployer:latest --load . && ' +
        `docker save hoster-deployer:latest | gzip | ${sshPrefix} ${shQuote('gunzip | sudo -n /usr/local/bin/docker load')}`,
    },
    {
      kind: 'nas-exec',
      description: '.env 파일 작성(mode 0600) 및 docker compose up -d',
      command: `${envWriteCmd} && ${composeUpCmd}`,
      id: 'env-write',
    },
    // IMPORTANT (리뷰 지시): write-config는 healthz 확인보다 먼저 실행되어야 한다. 이 시점
    // 이후 실패(네트워크 진단 경고, healthz 재시도 6회 소진)는 로컬 설정 저장을 막을 이유가
    // 되지 않는다 — 터널/DNS/.env(HMAC_SECRET 포함)는 이미 NAS에 존재하므로, 여기서 설정을
    // 저장해두지 않으면 사용자가 재시도할 때 시크릿/터널ID를 알 방법이 없어 터널 이름
    // 충돌(hoster init)에 부딪힌다.
    {
      kind: 'write-config',
      description: '~/.hoster/config.json 저장',
    },
    {
      kind: 'nas-exec',
      description: 'hoster-net 외부 통신 진단',
      command:
        'sudo -n /usr/local/bin/docker run --rm --network hoster-net alpine:3.20 wget -q -O- -T 10 https://one.one.one.one',
      id: 'network-diagnostic',
    },
    {
      kind: 'local-exec',
      description: '터널 경유 healthz 확인 (전파 지연 대비 10초 간격 6회 재시도)',
      command: `curl -fsS ${shQuote(`https://hoster.${baseDomain}/healthz`)}`,
      id: 'healthz-check',
    },
  ];
}

export interface LocalExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

// runInit이 실제로 사용하는 Nas의 부분집합만 구조적으로 요구한다 — 테스트에서
// `new Nas({ ..., runner: fakeRunner })`를 그대로 주입할 수도 있고, 순수 목(mock)
// 객체를 주입할 수도 있다.
export interface NasLike {
  exec(remoteCmd: string, stdin?: Buffer): Promise<string>;
  transferDir(localDir: string, remoteParent: string): Promise<void>;
}

export interface InitDeps {
  // 테스트에서 프롬프트 없이 고정된 입력을 주입하기 위한 우회 경로.
  // runInit의 공개 시그니처(opts: { dryRun, stackDir, deps })는 브리핑 계약을 그대로 유지한다.
  input?: InitInput;
  nas?: NasLike;
  makeCloudflare?: (opts: {
    apiToken: string;
    accountId: string;
    zoneId: string;
  }) => Pick<
    Cloudflare,
    'createTunnel' | 'setTunnelIngress' | 'upsertDnsCname' | 'getTunnelToken' | 'findTunnelByName' | 'deleteTunnel'
  >;
  runLocal?: (command: string) => Promise<LocalExecResult>;
  ask?: (question: string) => Promise<string>;
  askHidden?: (question: string) => Promise<string>;
  randomHex?: (bytes: number) => string;
  saveConfig?: (cfg: HosterConfig) => void;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  // 프롬프트를 띄울 수 있는 환경인지 판단한다. 파이프/CI에서는 응답을 받을 수 없으므로
  // 선택을 묻지 않고 안전한 기본값(기존 터널 재사용)으로 진행한다.
  isInteractive?: () => boolean;
  // 진행 표시 출력 경로. 테스트에서는 비-TTY io를 주입해 제어 문자 없이 줄 단위로 검증한다.
  progressIo?: ProgressIo;
}

const defaultRunLocal = (command: string): Promise<LocalExecResult> =>
  new Promise((resolve) => {
    execFile('sh', ['-c', command], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code =
        !err ? 0 : typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? (err as unknown as { code: number }).code
          : 1;
      resolve({ code, stdout, stderr });
    });
  });

// 빨간색 경고 출력 (네트워크 진단 실패 시).
function defaultWarn(msg: string): void {
  console.error(`\x1b[31m${msg}\x1b[0m`);
}

// Cloudflare가 반환하는 정확한 문구는 문서화되어 있지 않아(운영 관찰 기반 추정) 이름
// 충돌에 "특정적인" 패턴만 좁게 매치한다. `not available`/`in use`는 요금제 제한
// ("Tunnels not available on your plan")이나 일시 장애 등 이름 충돌과 무관한 실패에도
// 흔히 등장해 오탐(false positive) 위험이 커서 제외했다 — 매치되지 않는 실패(인증
// 오류, 레이트리밋, 요금제 제한 등)는 원본 에러를 그대로 전파한다.
const TUNNEL_NAME_CONFLICT_RE = /already exists|duplicate/i;

export type TunnelChoice = 'reuse' | 'recreate' | 'abort';

// 같은 이름의 터널이 이미 있을 때 무엇을 할지 결정한다. Cloudflare 대시보드를 열지 않고
// CLI 안에서 끝내기 위한 경로 — 삭제는 되돌릴 수 없으므로 기본값은 항상 재사용이다.
export async function chooseTunnelAction(
  tunnel: TunnelSummary,
  io: {
    ask: (q: string) => Promise<string>;
    log: (m: string) => void;
    interactive: boolean;
  }
): Promise<TunnelChoice> {
  const shortId = tunnel.id.slice(0, 8);
  if (!io.interactive) {
    io.log(
      `'${tunnel.name}' 터널이 이미 존재합니다 (ID: ${shortId}…). ` +
        '비대화형 환경이므로 기존 터널을 재사용합니다. 새로 만들려면 Cloudflare에서 삭제 후 다시 실행하세요.'
    );
    return 'reuse';
  }

  io.log(
    `\n'${tunnel.name}' 터널이 이미 존재합니다 (ID: ${shortId}…, 활성 커넥션 ${tunnel.connections}개).\n` +
      '  [1] 재사용 — 토큰만 다시 발급받아 계속 (기본값)\n' +
      '  [2] 삭제 후 새로 생성 — Cloudflare에서 되돌릴 수 없음\n' +
      '  [3] 중단'
  );

  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await io.ask('선택 [1]: ')).trim();
    if (answer === '' || answer === '1') return 'reuse';
    if (answer === '3') return 'abort';
    if (answer === '2') {
      if (tunnel.connections === 0) return 'recreate';
      // 커넥션이 붙어있으면 다른 곳에서 쓰는 터널일 수 있다.
      const confirm = (
        await io.ask(`활성 커넥션 ${tunnel.connections}개가 붙어있습니다. 정말 삭제하려면 yes를 입력하세요: `)
      ).trim();
      if (confirm.toLowerCase() === 'yes') return 'recreate';
      io.log('삭제를 취소했습니다 — 기존 터널을 재사용합니다.');
      return 'reuse';
    }
    io.log(`'${answer}'는 올바른 선택이 아닙니다. 1, 2, 3 중에서 입력하세요.`);
  }
  return 'abort';
}

// 오탐 시에도 사용자가 유일하게 가진 진단 정보(원본 에러)를 잃지 않도록 항상 함께 담는다.
function tunnelConflictMessage(originalMessage: string): string {
  return (
    "이미 'hoster' 터널이 존재합니다. Cloudflare 대시보드(Zero Trust > Networks > Tunnels)에서 " +
    '기존 터널을 삭제한 뒤 다시 실행하거나, `hoster init --reuse-tunnel <터널ID>`로 기존 터널을 재사용하세요.\n' +
    `(원본 오류: ${originalMessage})`
  );
}

// 시크릿 생성(HMAC_SECRET 등) 이후 어느 단계에서든 실패하면, NAS/로컬에 남아있을 수 있는
// 상태를 secrets 없이 안내한다 — 실제로 도달한 단계만 언급해 거짓 정보를 주지 않는다.
function printRecoveryNote(
  log: (msg: string) => void,
  progress: { stackTransferred: boolean; envWritten: boolean; configSaved: boolean }
): void {
  if (!progress.stackTransferred && !progress.envWritten && !progress.configSaved) return;
  log('');
  log('중단됨 — 현재 상태:');
  if (progress.stackTransferred) {
    log(`  - ${REMOTE_STACK_DIR} 에 stack 디렉터리가 이미 전송되었습니다.`);
  }
  if (progress.envWritten) {
    log('  - .env 파일이 이미 작성되었습니다 (HMAC_SECRET 포함).');
    log('  재시도하면 HMAC_SECRET이 새로 생성됩니다. 이미 등록된 프로젝트가 있다면 해당');
    log('  GitHub 저장소의 HOSTER_DEPLOY_SECRET을 새 값으로 갱신하거나, 재시도 전 NAS의');
    log(`  ${REMOTE_STACK_DIR} 디렉터리를 제거한 뒤 다시 실행하세요.`);
  }
  // IMPORTANT (리뷰 지시): 이 시점 이후 실패(네트워크 진단/healthz)는 로컬 설정이 이미
  // 저장된 뒤이므로, 사용자가 시크릿/터널ID를 다시 확인할 방법이 있다는 점을 알려준다.
  if (progress.configSaved) {
    log('  - ~/.hoster/config.json 파일이 이미 저장되었습니다 — 터널/DNS/.env 설치는');
    log('  대부분 완료된 상태이며, 이 설정을 재시도 없이 그대로 사용할 수 있습니다.');
    log('  DNS 전파를 기다렸다가 `curl https://hoster.<baseDomain>/healthz`로 다시 확인하거나,');
    log('  계속 실패하면 NAS에서 `docker compose logs`로 원인을 확인하세요.');
  }
}

async function retry(
  fn: () => Promise<LocalExecResult>,
  attempts: number,
  delayMs: number,
  sleep: (ms: number) => Promise<void>,
  onAttempt?: (attempt: number, total: number) => void
): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) onAttempt?.(i + 1, attempts);
    try {
      const r = await fn();
      if (r.code === 0) return;
      lastErr = new Error(r.stderr || r.stdout);
    } catch (e) {
      lastErr = e;
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  throw new Error(`healthz 확인 실패 (${attempts}회 재시도): ${String(lastErr)}`);
}

// cf-api 액션의 args에는 시크릿이 전혀 포함되지 않는다(Cloudflare 인증정보는 클라이언트
// 인스턴스 생성 시에만 쓰인다) — 유일한 런타임 치환 대상은 createTunnel 결과로 얻는
// tunnelId 뿐이다. `$`가 포함된 값이 String.replaceAll의 특수 패턴으로 해석되지 않도록
// split/join을 사용한다.
function substituteArgs(args: unknown[], tunnelId: string): unknown[] {
  const replace = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split('${TUNNEL_ID}').join(tunnelId);
    if (Array.isArray(v)) return v.map(replace);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, replace(val)]));
    }
    return v;
  };
  return args.map(replace);
}

export async function runInit(opts: {
  dryRun: boolean;
  stackDir: string;
  // 기존 'hoster' 터널을 새로 만들지 않고 재사용한다 (이름 충돌 시 안내 메시지가 권하는 경로).
  reuseTunnelId?: string;
  deps?: InitDeps;
}): Promise<void> {
  const deps = opts.deps ?? {};
  const log = deps.log ?? ((m: string) => console.log(m));

  const askPlain = deps.ask ?? ask;
  const askSecret = deps.askHidden ?? askHidden;

  const input: InitInput =
    deps.input ??
    ({ baseDomain: await askPlain('기본 도메인 (예: example.com): '), nas: defaultNas() } satisfies InitInput);

  const plan = planInit(input);

  if (opts.dryRun) {
    log(`--dry-run: 아래 ${plan.length}개 작업을 실행하지 않고 계획만 표시합니다.`);
    plan.forEach((a, i) => {
      log(`${i + 1}. [${a.kind}] ${a.description}`);
      if (a.command) log(`   $ ${a.command}`);
      if (a.method) log(`   -> ${a.method}(${JSON.stringify(a.args)})`);
    });
    return;
  }

  // Step 3: 사용자 입력 수집 (HMAC_SECRET은 자동 생성).
  const apiToken = await askSecret('Cloudflare API 토큰: ');
  const accountId = await askPlain('Cloudflare Account ID: ');
  const zoneId = await askPlain('Cloudflare Zone ID: ');
  const ghcrPat = await askSecret('GHCR Personal Access Token: ');
  const randomHex = deps.randomHex ?? ((n: number) => randomBytes(n).toString('hex'));
  const hmacSecret = randomHex(32);

  const nas = deps.nas ?? new Nas(input.nas);
  const cf = (deps.makeCloudflare ?? ((o) => new Cloudflare(o)))({ apiToken, accountId, zoneId });
  const runLocal = deps.runLocal ?? defaultRunLocal;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const warn = deps.warn ?? defaultWarn;
  const isInteractive = deps.isInteractive ?? (() => Boolean(process.stdin.isTTY));
  const save = deps.saveConfig ?? saveConfig;

  // 이미지 빌드·전송처럼 수 분이 걸리는 단계가 있어 아무 출력이 없으면 멈춘 것처럼 보인다.
  // 단계별 시작/완료를 항상 남긴다.
  const reporter = new ProgressReporter(deps.progressIo ?? defaultProgressIo(), plan.length);
  let stepNo = 0;

  let tunnelId = '';
  let tunnelToken = '';
  // 시크릿 생성 이후 실패 시 NAS/로컬에 남아있을 상태를 정확히 안내하기 위한 진행 추적
  // (시크릿 값 자체는 절대 담지 않는다).
  const progress = { stackTransferred: false, envWritten: false, configSaved: false };

  try {
    for (const action of plan) {
      stepNo++;
      reporter.start(stepNo, action.description);
      switch (action.kind) {
        case 'local-exec': {
          const cmd = substitutePlaceholders(action.command!, { BASE_DOMAIN: input.baseDomain });
          if (action.id === 'healthz-check') {
            await retry(() => runLocal(cmd), 6, 10_000, sleep, (attempt, total) =>
              reporter.note(`재시도 ${attempt}/${total}`)
            );
          } else {
            const r = await runLocal(cmd);
            if (r.code !== 0) throw new Error(`로컬 명령 실패: ${r.stderr || r.stdout}`);
          }
          break;
        }

        case 'nas-exec': {
          const cmd = substitutePlaceholders(action.command!, {
            TUNNEL_TOKEN: tunnelToken,
            HMAC_SECRET: hmacSecret,
            GHCR_PAT: ghcrPat,
            BASE_DOMAIN: input.baseDomain,
          });
          try {
            await nas.exec(cmd);
            if (action.id === 'env-write') progress.envWritten = true;
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            if (action.id === 'network-create' && /exists/i.test(message)) {
              log('hoster-net 네트워크가 이미 존재합니다 — 무시합니다.');
            } else if (action.id === 'network-diagnostic') {
              // IMPORTANT (리뷰 지시): 이 실패를 "무시해도 되는 경우가 있다"고 안내하면 안 된다
              // — cloudflared 컨테이너 자체가 hoster-net 위에서 실행되며 Cloudflare로 나가는
              // 외부 통신이 반드시 필요하므로, 이 진단이 실패하면 터널이 연결되지 않고
              // 뒤이은 healthz 확인도 반드시 실패한다.
              warn(
                'hoster-net에서 외부 통신 불가. DSM 방화벽/IP forward 설정을 확인하세요. ' +
                  'cloudflared도 hoster-net 위에서 실행되며 Cloudflare로 나가는 외부 통신이 반드시 필요하므로, ' +
                  '이 진단이 실패하면 터널이 연결되지 않아 다음 healthz 확인도 실패합니다 — 무시하고 넘어갈 수 없습니다.'
              );
            } else {
              throw e;
            }
          }
          break;
        }

        case 'nas-transfer': {
          await nas.exec(STATE_DIR_CMD);
          await nas.transferDir(opts.stackDir, REMOTE_TMP_DIR);
          const base = basename(opts.stackDir);
          await nas.exec(
            `cp -a ${REMOTE_TMP_DIR}/${shQuote(base)}/. ${REMOTE_STACK_DIR}/ && rm -rf ${REMOTE_TMP_DIR}`
          );
          progress.stackTransferred = true;
          break;
        }

        case 'cf-api': {
          const method = action.method as 'createTunnel' | 'setTunnelIngress' | 'upsertDnsCname';

          if (method === 'createTunnel') {
            const name = (action.args?.[0] as string) ?? 'hoster';
            if (opts.reuseTunnelId) {
              tunnelId = opts.reuseTunnelId;
              tunnelToken = await cf.getTunnelToken(tunnelId);
            } else {
              // 생성 전에 같은 이름의 터널을 먼저 찾아, 충돌 시 사용자가 대시보드를 열지 않고
              // CLI 안에서 재사용/삭제를 선택할 수 있게 한다. 조회 실패(권한 부족 등)는
              // 치명적이지 않으므로 경고 후 기존 생성 경로로 넘어간다.
              let existing: TunnelSummary | undefined;
              try {
                existing = await cf.findTunnelByName(name);
              } catch (e) {
                warn(`기존 터널 조회에 실패했습니다 (${e instanceof Error ? e.message : String(e)}) — 생성을 시도합니다.`);
              }

              if (existing) {
                // 입력을 받는 동안 스피너가 프롬프트 줄을 덮어쓰지 않도록 멈춘다.
                reporter.pause();
                const choice = await chooseTunnelAction(existing, {
                  ask: askPlain,
                  log,
                  interactive: isInteractive(),
                });
                reporter.resume();
                if (choice === 'abort') {
                  throw new Error("기존 'hoster' 터널 처리를 선택하지 않아 중단했습니다.");
                }
                if (choice === 'reuse') {
                  tunnelId = existing.id;
                  tunnelToken = await cf.getTunnelToken(existing.id);
                  log(`기존 터널을 재사용합니다 (ID: ${existing.id.slice(0, 8)}…).`);
                  break;
                }
                await cf.deleteTunnel(existing.id);
                log('기존 터널을 삭제했습니다 — 새로 생성합니다.');
              }

              try {
                const r = await cf.createTunnel(name);
                tunnelId = r.id;
                tunnelToken = r.token;
              } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                if (TUNNEL_NAME_CONFLICT_RE.test(message)) {
                  throw new Error(tunnelConflictMessage(message));
                }
                throw e;
              }
            }
            break;
          }

          const args = substituteArgs(action.args ?? [], tunnelId);
          const fn = cf[method] as (...a: unknown[]) => Promise<unknown>;
          await fn.apply(cf, args);
          break;
        }

        case 'write-config': {
          save({
            nas: input.nas,
            cloudflare: { apiToken, accountId, zoneId, tunnelId },
            baseDomain: input.baseDomain,
            deployerUrl: `https://hoster.${input.baseDomain}`,
            hmacSecret,
            ghcrPat,
          });
          progress.configSaved = true;
          break;
        }
      }
      reporter.succeed();
    }
  } catch (e) {
    reporter.fail();
    printRecoveryNote(log, progress);
    throw e;
  }
}
