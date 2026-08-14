import type { HosterConfig } from './config.js';

// `hoster init`이 필요로 하는 모든 설정값. 어느 경로(옵션/환경변수/기존 설정/프롬프트)로
// 들어왔는지와 무관하게 여기서 검증을 마친 값만 담긴다.
export interface InitSettings {
  baseDomain: string;
  nas: { host: string; port: number; user: string };
  cloudflare: { apiToken: string; accountId: string; zoneId: string };
  ghcrPat: string;
  hmacSecret: string;
  // 기존 설정의 HMAC_SECRET을 유지하지 않고 새로 만들었는지. 새로 만들었다면 이미 등록된
  // 레포의 GitHub 시크릿(HOSTER_DEPLOY_SECRET)을 다시 등록해야 한다.
  hmacRotated: boolean;
}

export interface InitCliOptions {
  nasHost?: string;
  nasPort?: string;
  nasUser?: string;
  baseDomain?: string;
  cfAccountId?: string;
  cfZoneId?: string;
  nonInteractive?: boolean;
  rotateHmac?: boolean;
}

// 셸에 보간되는 값이므로(shQuote를 거치더라도) 애초에 메타문자를 받지 않는다.
// 호스트명/IPv4 둘 다 이 집합으로 표현된다.
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const USER_RE = /^[a-zA-Z0-9._-]+$/;
// DNS 레이블 규칙 + 최소 한 개의 점. 이 값은 DNS 레코드명, 터널 인그레스 호스트명,
// Traefik 라우터 규칙에 그대로 들어간다.
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
// Cloudflare Account ID / Zone ID는 32자리 hex다. 오타를 조기에 잡기 위해 형식을 확인한다.
const CF_ID_RE = /^[0-9a-f]{32}$/i;

const DEFAULT_SSH_PORT = 22;
const PROMPT_ATTEMPTS = 3;

function parseHost(raw: string): string {
  const v = raw.trim();
  if (!HOST_RE.test(v)) {
    throw new Error('NAS 호스트는 IP나 호스트명이어야 합니다 (영숫자와 . _ - 만 허용).');
  }
  return v;
}

function parseUser(raw: string): string {
  const v = raw.trim();
  if (!USER_RE.test(v)) {
    throw new Error('NAS 사용자명은 영숫자와 . _ - 만 사용할 수 있습니다.');
  }
  return v;
}

function parsePort(raw: string): number {
  const v = raw.trim();
  const n = Number(v);
  if (v === '' || !Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error('SSH 포트는 1~65535 사이의 정수여야 합니다.');
  }
  return n;
}

function parseDomain(raw: string): string {
  // DNS는 대소문자를 구분하지 않으므로 소문자로 정규화한 뒤 검증한다.
  const v = raw.trim().toLowerCase();
  if (!DOMAIN_RE.test(v)) {
    throw new Error('기본 도메인은 example.com 형태여야 합니다 (프로토콜/경로/공백 없이, 점 하나 이상).');
  }
  return v;
}

function parseCfId(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (!CF_ID_RE.test(v)) {
    throw new Error('Cloudflare ID는 32자리 16진수여야 합니다 (대시 없이 붙여서 입력).');
  }
  return v;
}

function parseSecret(raw: string): string {
  const v = raw.trim();
  if (v === '') throw new Error('빈 값은 사용할 수 없습니다.');
  return v;
}

export interface ResolveIo {
  ask: (question: string) => Promise<string>;
  askHidden: (question: string) => Promise<string>;
  log: (message: string) => void;
}

interface FieldSpec<T> {
  // 프롬프트와 에러 메시지에 함께 쓰이는 사람이 읽는 이름.
  label: string;
  option: string;
  env: string;
  parse: (raw: string) => T;
  // 프롬프트에 [기본값]으로 표시하고 빈 입력 시 채택할 값.
  fallback?: T;
  // 기본값을 화면에 표시할지. 시크릿은 false — 존재 사실만 알리고 값은 숨긴다.
  showFallback?: boolean;
  hidden?: boolean;
  hint?: string;
}

// 한 설정값을 우선순위대로 확정한다:
// CLI 옵션 > 환경변수 > (대화형) 프롬프트 > 기존 설정/기본값 > 에러.
async function resolveField<T>(
  spec: FieldSpec<T>,
  cliValue: string | undefined,
  env: NodeJS.ProcessEnv,
  interactive: boolean,
  io: ResolveIo
): Promise<T> {
  // 명시적으로 준 값이 잘못됐다면 프롬프트로 넘어가지 않고 즉시 알린다 —
  // 사용자가 의도한 입력이 조용히 무시되면 안 된다.
  if (cliValue !== undefined) {
    try {
      return spec.parse(cliValue);
    } catch (e) {
      throw new Error(`${spec.option} 값이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const envValue = env[spec.env];
  if (envValue !== undefined && envValue !== '') {
    try {
      return spec.parse(envValue);
    } catch (e) {
      throw new Error(`환경변수 ${spec.env} 값이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (interactive) {
    const suffix =
      spec.fallback !== undefined
        ? spec.showFallback === false
          ? ' (엔터 = 기존 값 유지)'
          : ` [${String(spec.fallback)}]`
        : '';
    const question = `${spec.label}${spec.hint ? ` ${spec.hint}` : ''}${suffix}: `;
    for (let attempt = 0; attempt < PROMPT_ATTEMPTS; attempt++) {
      const answer = spec.hidden ? await io.askHidden(question) : await io.ask(question);
      if (answer.trim() === '') {
        if (spec.fallback !== undefined) return spec.fallback;
        io.log(`${spec.label} 값이 필요합니다.`);
        continue;
      }
      try {
        return spec.parse(answer);
      } catch (e) {
        io.log(e instanceof Error ? e.message : String(e));
      }
    }
    throw new Error(`${spec.label} 값을 확정하지 못해 중단했습니다.`);
  }

  if (spec.fallback !== undefined) return spec.fallback;
  throw new Error(
    `${spec.label} 값이 없습니다. ${spec.option} 옵션이나 ${spec.env} 환경변수로 지정하세요 ` +
      '(대화형 터미널에서 실행하면 프롬프트로 입력할 수 있습니다).'
  );
}

// HMAC_SECRET은 재실행 시 기본적으로 기존 값을 유지한다. 새로 만들면 이미 등록된 레포의
// GitHub 시크릿(HOSTER_DEPLOY_SECRET)이 전부 어긋나 서명 검증에 실패하기 때문이다.
async function resolveHmacSecret(opts: {
  existing?: string;
  rotate: boolean;
  interactive: boolean;
  randomHex: (bytes: number) => string;
  io: ResolveIo;
}): Promise<{ secret: string; rotated: boolean }> {
  // 유지하기로 결정되면 아예 생성하지 않는다 — 쓰지 않을 시크릿을 만들지 않는다.
  const generate = (): { secret: string; rotated: boolean } => ({ secret: opts.randomHex(32), rotated: true });
  const rotateNote =
    'HMAC_SECRET을 새로 생성했습니다 — 이미 등록된 레포가 있다면 각 레포에서 `hoster add`를 다시 실행해 ' +
    'GitHub 시크릿(HOSTER_DEPLOY_SECRET)을 갱신해야 배포 서명 검증이 통과합니다.';

  if (!opts.existing) return generate();

  if (opts.rotate) {
    opts.io.log(rotateNote);
    return generate();
  }

  if (!opts.interactive) {
    opts.io.log(
      '기존 HMAC_SECRET을 유지합니다 — 이미 등록된 레포의 GitHub 시크릿을 다시 등록할 필요가 없습니다. ' +
        '새로 만들려면 --rotate-hmac을 지정하세요.'
    );
    return { secret: opts.existing, rotated: false };
  }

  const answer = (
    await opts.io.ask(
      'HMAC_SECRET을 새로 생성할까요? 새로 만들면 등록된 모든 레포에서 `hoster add`를 다시 실행해 ' +
        'GitHub 시크릿(HOSTER_DEPLOY_SECRET)을 갱신해야 합니다 [y/N]: '
    )
  )
    .trim()
    .toLowerCase();

  if (answer === 'y' || answer === 'yes') {
    opts.io.log(rotateNote);
    return generate();
  }
  opts.io.log('기존 HMAC_SECRET을 유지합니다 — 등록된 레포의 GitHub 시크릿은 그대로 유효합니다.');
  return { secret: opts.existing, rotated: false };
}

export async function resolveInitSettings(opts: {
  cli: InitCliOptions;
  env: NodeJS.ProcessEnv;
  // 기존 ~/.hoster/config.json. 재실행 시 프롬프트 기본값과 비대화형 폴백으로 쓰인다.
  existing?: HosterConfig;
  interactive: boolean;
  // dry-run은 계획만 출력하므로 시크릿/Cloudflare 인증정보를 요구하지 않는다.
  includeCredentials: boolean;
  // 이미 확정된 접속 정보/도메인 (테스트 주입 경로). 주어지면 그 부분의 해석을 건너뛴다.
  preset?: { baseDomain: string; nas: { host: string; port: number; user: string } };
  ask: ResolveIo['ask'];
  askHidden: ResolveIo['askHidden'];
  log: ResolveIo['log'];
  randomHex: (bytes: number) => string;
}): Promise<InitSettings> {
  const { cli, env, existing, interactive, includeCredentials, preset } = opts;
  const io: ResolveIo = { ask: opts.ask, askHidden: opts.askHidden, log: opts.log };

  // 순서는 프롬프트 흐름이자 에러 우선순위다 — 접속 정보를 먼저 확정해야
  // 도메인/인증정보를 입력한 뒤에야 NAS 주소가 틀렸다는 걸 알게 되는 일이 없다.
  const host =
    preset?.nas.host ??
    (await resolveField(
      {
        label: 'NAS 호스트',
        option: '--nas-host',
        env: 'HOSTER_NAS_HOST',
        parse: parseHost,
        fallback: existing?.nas.host,
        hint: '(IP 또는 호스트명)',
      },
      cli.nasHost,
      env,
      interactive,
      io
    ));

  const port =
    preset?.nas.port ??
    (await resolveField(
      {
        label: 'NAS SSH 포트',
        option: '--nas-port',
        env: 'HOSTER_NAS_PORT',
        parse: parsePort,
        fallback: existing?.nas.port ?? DEFAULT_SSH_PORT,
      },
      cli.nasPort,
      env,
      interactive,
      io
    ));

  const user =
    preset?.nas.user ??
    (await resolveField(
      {
        label: 'NAS 사용자',
        option: '--nas-user',
        env: 'HOSTER_NAS_USER',
        parse: parseUser,
        fallback: existing?.nas.user,
      },
      cli.nasUser,
      env,
      interactive,
      io
    ));

  const baseDomain =
    preset?.baseDomain ??
    (await resolveField(
      {
        label: '기본 도메인',
        option: '--base-domain',
        env: 'HOSTER_BASE_DOMAIN',
        parse: parseDomain,
        fallback: existing?.baseDomain,
        hint: '(예: example.com)',
      },
      cli.baseDomain,
      env,
      interactive,
      io
    ));

  if (!includeCredentials) {
    // 계획에는 Cloudflare 인증정보가 들어가지 않지만, 사용자가 명시적으로 준 값이
    // 잘못됐다면 dry-run에서도 알려준다 — 실행 때 가서야 알게 되면 늦다.
    for (const [option, value] of [
      ['--cf-account-id', cli.cfAccountId],
      ['--cf-zone-id', cli.cfZoneId],
    ] as const) {
      if (value === undefined) continue;
      try {
        parseCfId(value);
      } catch (e) {
        throw new Error(`${option} 값이 올바르지 않습니다: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return {
      baseDomain,
      nas: { host, port, user },
      cloudflare: { apiToken: '', accountId: '', zoneId: '' },
      ghcrPat: '',
      hmacSecret: '',
      hmacRotated: false,
    };
  }

  const apiToken = await resolveField(
    {
      label: 'Cloudflare API 토큰',
      option: '(옵션 없음 — 환경변수나 프롬프트로 입력)',
      env: 'HOSTER_CF_API_TOKEN',
      parse: parseSecret,
      fallback: existing?.cloudflare.apiToken,
      showFallback: false,
      hidden: true,
    },
    undefined,
    env,
    interactive,
    io
  );

  const accountId = await resolveField(
    {
      label: 'Cloudflare Account ID',
      option: '--cf-account-id',
      env: 'HOSTER_CF_ACCOUNT_ID',
      parse: parseCfId,
      fallback: existing?.cloudflare.accountId,
    },
    cli.cfAccountId,
    env,
    interactive,
    io
  );

  const zoneId = await resolveField(
    {
      label: 'Cloudflare Zone ID',
      option: '--cf-zone-id',
      env: 'HOSTER_CF_ZONE_ID',
      parse: parseCfId,
      fallback: existing?.cloudflare.zoneId,
    },
    cli.cfZoneId,
    env,
    interactive,
    io
  );

  const ghcrPat = await resolveField(
    {
      label: 'GHCR Personal Access Token',
      option: '(옵션 없음 — 환경변수나 프롬프트로 입력)',
      env: 'HOSTER_GHCR_PAT',
      parse: parseSecret,
      fallback: existing?.ghcrPat,
      showFallback: false,
      hidden: true,
    },
    undefined,
    env,
    interactive,
    io
  );

  const hmac = await resolveHmacSecret({
    existing: existing?.hmacSecret,
    rotate: Boolean(cli.rotateHmac),
    interactive,
    randomHex: opts.randomHex,
    io,
  });

  return {
    baseDomain,
    nas: { host, port, user },
    cloudflare: { apiToken, accountId, zoneId },
    ghcrPat,
    hmacSecret: hmac.secret,
    hmacRotated: hmac.rotated,
  };
}
