import { execFile } from 'node:child_process';
import type { Cloudflare } from '../cloudflare.js';
import type { DeployerClient } from '../client.js';
import { parseGitHubRepo, projectNameOf } from '../repo.js';
import { planInit } from './init.js';
import { withSpinner, type ProgressIo } from '../progress.js';

// ── 순수 함수 ────────────────────────────────────────────────────────────

export function parseEnvArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const i = a.indexOf('=');
    if (i <= 0) throw new Error(`KEY=VAL 형식이어야 합니다: ${a}`);
    out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

export function formatLs(
  projects: { name: string; domain: string; currentImage: string | null }[]
): string {
  const rows = projects.map((p) => [
    p.name,
    p.domain,
    p.currentImage ? p.currentImage.split(':').pop()!.slice(0, 7) : '-',
  ]);
  const widths = [0, 1, 2].map((i) =>
    Math.max('NAME DOMAIN IMAGE'.split(' ')[i].length, ...rows.map((r) => r[i].length))
  );
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  return [line(['NAME', 'DOMAIN', 'IMAGE']), ...rows.map(line)].join('\n');
}

// ── ls ───────────────────────────────────────────────────────────────────

interface StatusProjectLike {
  name: string;
  domain: string;
  currentImage: string | null;
}

export interface LsDeps {
  client: Pick<DeployerClient, 'status'>;
  log?: (msg: string) => void;
}

export async function runLs(deps: LsDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const projects = (await deps.client.status()) as StatusProjectLike[];
  if (!Array.isArray(projects) || projects.length === 0) {
    log('등록된 프로젝트가 없습니다.');
    return;
  }
  log(formatLs(projects.map((p) => ({ name: p.name, domain: p.domain, currentImage: p.currentImage }))));
}

// ── status ───────────────────────────────────────────────────────────────

interface DeploymentLike {
  id: number;
  image: string;
  sha: string;
  status: string;
  error: string | null;
  createdAt: string;
}

interface ProjectStatusLike extends StatusProjectLike {
  previousImage: string | null;
  deployments: DeploymentLike[];
}

export interface StatusDeps {
  client: Pick<DeployerClient, 'statusOf'>;
  log?: (msg: string) => void;
}

export async function runStatus(project: string, deps: StatusDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const p = (await deps.client.statusOf(project)) as ProjectStatusLike;
  log(`이름: ${p.name}`);
  log(`도메인: ${p.domain}`);
  log(`현재 이미지: ${p.currentImage ?? '-'}`);
  log(`이전 이미지: ${p.previousImage ?? '-'}`);
  log('');
  log('최근 배포 이력:');
  if (!p.deployments || p.deployments.length === 0) {
    log('  (없음)');
    return;
  }
  for (const d of p.deployments) {
    const shortImage = d.image.split(':').pop();
    const errSuffix = d.error ? `  error=${d.error}` : '';
    log(`  #${d.id}  ${d.createdAt}  ${d.status}  ${shortImage}${errSuffix}`);
  }
}

// ── logs ─────────────────────────────────────────────────────────────────

export interface LogsDeps {
  client: Pick<DeployerClient, 'logs'>;
  log?: (msg: string) => void;
}

export async function runLogs(project: string, tail: number, deps: LogsDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const text = await deps.client.logs(project, tail);
  log(text);
}

// ── rollback ─────────────────────────────────────────────────────────────

// FIX (리뷰 지시, round 2): DeployerClient.request()(client.ts)는 2xx가 아닌 응답에서
// `deployer 응답 ${status}: ${rawBody}` 형태로 throw하고, deployer는 실패한 rollback/deploy에
// HTTP 500을 반환한다(packages/deployer/src/app.ts) — 즉 성공적으로 반환된 결과의
// status는 실제로는 항상 'success'뿐이고 'failed'는 절대 여기까지 오지 않는다(항상
// throw로 먼저 걸러짐). 예전 `result.status !== 'success'` 분기는 실제로는 도달 불가능한
// 죽은 코드였다 — 사용자는 이 분기 대신 원본 "deployer 응답 500: {...}" 텍스트를 그대로
// 봤다. rawBody는 보통 JSON({"status":"failed","error":"..."} 또는 {"error":"..."})이므로
// 그 error 필드만 추출해 보여주고, JSON이 아니거나 error 필드가 없으면 원본 메시지를 그대로
// 쓴다.
function friendlyDeployerErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const match = raw.match(/^deployer 응답 \d+: ([\s\S]*)$/);
  if (!match) return raw;
  try {
    const body = JSON.parse(match[1]) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // JSON이 아니면 원본 메시지를 그대로 사용한다.
  }
  return raw;
}

export interface RollbackDeps {
  client: Pick<DeployerClient, 'rollback'>;
  log?: (msg: string) => void;
  progressIo?: ProgressIo;
}

export async function runRollback(project: string, deps: RollbackDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  try {
    // deployer가 컨테이너를 교체하고 헬스체크(최대 60초)를 마칠 때까지 기다린다.
    await withSpinner(`"${project}" 롤백 중 (deployer 헬스체크 대기)`, () => deps.client.rollback(project), deps.progressIo);
  } catch (e) {
    throw new Error(`롤백 실패: ${friendlyDeployerErrorMessage(e)}`);
  }
  log(`프로젝트 "${project}"를 이전 이미지로 롤백했습니다.`);
}

// ── env ──────────────────────────────────────────────────────────────────

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string }
) => Promise<{ code: number; stdout: string; stderr: string }>;

function exitCodeOf(err: (Error & { code?: unknown }) | null): number {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : 1;
}

const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: exitCodeOf(err), stdout, stderr });
    });
  });

// hoster add가 등록한 프로젝트명과 동일한 규칙(parseGitHubRepo + projectNameOf)으로
// 추론해야 `hoster env`가 다른 이름을 만들어 "프로젝트 없음"을 유발하지 않는다.
export async function inferProjectName(run: Runner, cwd: string): Promise<string> {
  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd });
  if (remote.code !== 0) {
    throw new Error(
      `프로젝트를 추론할 수 없습니다 (git 원격(origin) 조회 실패): ${remote.stderr || remote.stdout}. --project 옵션으로 직접 지정하세요.`
    );
  }
  const { repo } = parseGitHubRepo(remote.stdout);
  return projectNameOf(repo);
}

export interface EnvOpts {
  project?: string;
  redeploy?: boolean;
}

export interface EnvDeps {
  client: Pick<DeployerClient, 'env' | 'statusOf' | 'deploy'>;
  run?: Runner;
  cwd?: string;
  log?: (msg: string) => void;
  progressIo?: ProgressIo;
}

export async function runEnv(
  action: 'set' | 'rm',
  args: string[],
  opts: EnvOpts,
  deps: EnvDeps
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const run = deps.run ?? defaultRunner;
  const cwd = deps.cwd ?? process.cwd();
  const project = opts.project ?? (await inferProjectName(run, cwd));

  const body = action === 'set' ? { set: parseEnvArgs(args) } : { remove: args };
  await deps.client.env(project, body);
  log(`프로젝트 "${project}"의 환경변수를 갱신했습니다.`);

  if (opts.redeploy) {
    const status = (await deps.client.statusOf(project)) as { currentImage: string | null };
    if (!status.currentImage) {
      throw new Error(`프로젝트 "${project}"에 배포된 이미지가 없어 재배포할 수 없습니다.`);
    }
    const sha = status.currentImage.split(':').pop()!;
    // runRollback과 동일한 이유로 'failed'는 여기까지 오지 않는다(HTTP 500 → throw) —
    // 성공적으로 반환되는 status는 'success' | 'skipped'뿐이다.
    let result: { status: 'success' | 'skipped' };
    try {
      result = (await withSpinner(
        `${status.currentImage} 재배포 중 (deployer 헬스체크 대기)`,
        () => deps.client.deploy({ project, image: status.currentImage!, sha }),
        deps.progressIo
      )) as {
        status: 'success' | 'skipped';
      };
    } catch (e) {
      throw new Error(`재배포 실패: ${friendlyDeployerErrorMessage(e)}`);
    }
    log(`이미지 ${status.currentImage} 로 재배포를 요청했습니다 (${result.status}).`);
  }
}

// ── remove ───────────────────────────────────────────────────────────────

export interface RemoveDeps {
  client: Pick<DeployerClient, 'removeProject' | 'statusOf'>;
  cf: Pick<Cloudflare, 'deleteDnsRecord'>;
  log?: (msg: string) => void;
}

// FIX (리뷰 지시, round 1): domain을 `${project}.${baseDomain}` 관례로 재구성하지 않는다 —
// deployer는 domain을 자체 컬럼으로 저장하고(POST /projects는 명시적 domain을 받아 관례를
// override할 수 있음, packages/deployer/src/app.ts) 있어 서버 모델이 이미 관례와 다른
// domain을 허용한다. 반드시 statusOf()로 실제 domain을 먼저 조회하고, 그 값을 그대로 DNS
// 삭제에 사용한다 — removeProject()를 먼저 호출하면 행이 삭제되어 실제 domain을 영영 알 수
// 없게 되고, 관례로 추측한 domain이 실제와 다를 경우 엉뚱한 DNS 레코드를 지우고 진짜
// 레코드는 남기게 된다.
export async function runRemove(project: string, deps: RemoveDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));

  let domain: string;
  try {
    const status = (await deps.client.statusOf(project)) as { domain: string };
    domain = status.domain;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(
      `프로젝트 "${project}" 정보를 조회할 수 없어 제거를 중단합니다(등록되지 않았을 수 있습니다): ${message}`
    );
  }

  // add.ts와 마찬가지로 두 원격 작업 사이에 원자성이 없다 — 어디까지 완료됐는지
  // 정확히 안내해야 사용자가 안전하게 재시도하거나 수동으로 정리할 수 있다.
  let deployerRemoved = false;
  try {
    await deps.client.removeProject(project);
    deployerRemoved = true;
    await deps.cf.deleteDnsRecord(domain);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (deployerRemoved) {
      throw new Error(
        `deployer 등록/컨테이너는 제거되었지만 DNS 레코드(${domain}) 삭제에 실패했습니다: ${message}. Cloudflare 대시보드에서 직접 삭제하세요.`
      );
    }
    throw new Error(`프로젝트 "${project}" 제거(deployer 등록/컨테이너)에 실패했습니다: ${message}`);
  }

  log(`프로젝트 "${project}"가 제거되었습니다 (deployer 등록/컨테이너 + DNS 레코드 ${domain}).`);
  log(
    'workflow 파일(.github/workflows/hoster-deploy.yml)은 자동으로 삭제되지 않습니다 — 레포에서 직접 삭제하세요.'
  );
}

// ── doctor ───────────────────────────────────────────────────────────────

interface DoctorNas {
  exec(remoteCmd: string): Promise<string>;
}

interface DoctorLocalResult {
  code: number;
  stdout: string;
  stderr: string;
}

const defaultDoctorRunLocal = (command: string): Promise<DoctorLocalResult> =>
  new Promise((resolve) => {
    execFile('sh', ['-c', command], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: exitCodeOf(err), stdout, stderr });
    });
  });

export interface DoctorDeps {
  input: { baseDomain: string; nas: { host: string; port: number; user: string } };
  nas?: DoctorNas;
  makeNas?: (nas: { host: string; port: number; user: string }) => DoctorNas;
  runLocal?: (command: string) => Promise<DoctorLocalResult>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

// init의 사전 점검(ssh/docker 권한, docker compose 플러그인) + hoster-net 외부 통신
// 진단만 재실행한다. planInit()이 만드는 계획 중 상태를 바꾸는 액션(터널/DNS 생성,
// 네트워크 생성, 이미지 빌드/전송, .env 작성/compose up)은 절대 실행하지 않는다.
export async function runDoctor(deps: DoctorDeps): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const runLocal = deps.runLocal ?? defaultDoctorRunLocal;
  const nas = deps.nas ?? (deps.makeNas ? deps.makeNas(deps.input.nas) : undefined);
  if (!nas) throw new Error('doctor: NAS 접속 정보를 준비할 수 없습니다.');

  // FIX (리뷰 지시, round 2): 설명 문자열 매칭이나 "id 없는 유일한 nas-exec" 같은 방식은
  // planInit의 문구/순서가 바뀌면 조용히 깨진다 — init.ts가 부여하는 안정적인 id로만
  // 찾는다.
  const plan = planInit(deps.input);
  const precheck = plan.find((a) => a.id === 'ssh-docker-precheck');
  const composeCheck = plan.find((a) => a.id === 'compose-check');
  const netDiag = plan.find((a) => a.id === 'network-diagnostic');

  if (precheck?.command) {
    log(`점검: ${precheck.description}`);
    const r = await runLocal(precheck.command);
    if (r.code !== 0) throw new Error(`NAS 접속/docker 권한 점검 실패: ${r.stderr || r.stdout}`);
    log('  OK');
  }

  if (composeCheck?.command) {
    log(`점검: ${composeCheck.description}`);
    await nas.exec(composeCheck.command);
    log('  OK');
  }

  if (netDiag?.command) {
    log(`점검: ${netDiag.description}`);
    try {
      await nas.exec(netDiag.command);
      log('  OK');
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      warn(`hoster-net에서 외부 통신 불가: ${message}`);
      warn('DSM 방화벽/IP forward 확인 필요. 앱이 외부 API를 사용하지 않으면 무시 가능.');
    }
  }

  log('doctor: 점검 완료 (변경 사항 없음)');
}
