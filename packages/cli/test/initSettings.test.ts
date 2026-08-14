import { describe, it, expect, vi } from 'vitest';
import { resolveInitSettings, type InitCliOptions } from '../src/initSettings.js';
import type { HosterConfig } from '../src/config.js';

const CF_ACCOUNT = 'a54f0650d84bb7ee5e3f487265c0a045';
const CF_ZONE = 'de062dc550085f373d78aeaadcb7042c';

function existingConfig(over: Partial<HosterConfig> = {}): HosterConfig {
  return {
    nas: { host: '192.168.10.11', port: 20022, user: 'super' },
    cloudflare: { apiToken: 'old-token', accountId: CF_ACCOUNT, zoneId: CF_ZONE, tunnelId: 'old-tunnel' },
    baseDomain: 'tlog.net',
    deployerUrl: 'https://hoster.tlog.net',
    hmacSecret: 'old-hmac-secret',
    ghcrPat: 'old-ghcr-pat',
    ...over,
  };
}

// 프롬프트 응답을 질문 문구로 매칭해 돌려준다. 실제 사용자처럼 순서에 의존하지 않는다.
function makeIo(answers: Record<string, string> = {}, hidden: Record<string, string> = {}) {
  const asked: string[] = [];
  const askedHidden: string[] = [];
  const logs: string[] = [];
  const pick = (q: string, table: Record<string, string>): string => {
    for (const [needle, value] of Object.entries(table)) {
      if (q.includes(needle)) return value;
    }
    return '';
  };
  return {
    asked,
    askedHidden,
    logs,
    ask: vi.fn(async (q: string) => {
      asked.push(q);
      return pick(q, answers);
    }),
    askHidden: vi.fn(async (q: string) => {
      askedHidden.push(q);
      return pick(q, hidden);
    }),
    log: vi.fn((m: string) => logs.push(m)),
  };
}

function resolve(opts: {
  cli?: InitCliOptions;
  env?: NodeJS.ProcessEnv;
  existing?: HosterConfig;
  interactive?: boolean;
  includeCredentials?: boolean;
  io?: ReturnType<typeof makeIo>;
  randomHex?: (n: number) => string;
}) {
  const io = opts.io ?? makeIo();
  return {
    io,
    promise: resolveInitSettings({
      cli: opts.cli ?? {},
      env: opts.env ?? {},
      existing: opts.existing,
      interactive: opts.interactive ?? false,
      includeCredentials: opts.includeCredentials ?? true,
      ask: io.ask,
      askHidden: io.askHidden,
      log: io.log,
      randomHex: opts.randomHex ?? (() => 'new-hmac-secret'),
    }),
  };
}

describe('resolveInitSettings — 우선순위', () => {
  it('CLI 옵션이 환경변수와 기존 설정보다 우선한다', async () => {
    const { promise } = resolve({
      cli: { nasHost: '10.0.0.5', nasPort: '2200', nasUser: 'deploy', baseDomain: 'cli.example.com' },
      env: {
        HOSTER_NAS_HOST: '10.0.0.9',
        HOSTER_NAS_PORT: '2299',
        HOSTER_NAS_USER: 'envuser',
        HOSTER_BASE_DOMAIN: 'env.example.com',
        HOSTER_CF_API_TOKEN: 'env-token',
        HOSTER_CF_ACCOUNT_ID: CF_ACCOUNT,
        HOSTER_CF_ZONE_ID: CF_ZONE,
        HOSTER_GHCR_PAT: 'env-pat',
      },
      existing: existingConfig(),
    });

    const s = await promise;
    expect(s.nas).toEqual({ host: '10.0.0.5', port: 2200, user: 'deploy' });
    expect(s.baseDomain).toBe('cli.example.com');
  });

  it('환경변수가 기존 설정보다 우선한다', async () => {
    const { promise } = resolve({
      env: {
        HOSTER_NAS_HOST: '10.0.0.9',
        HOSTER_NAS_PORT: '2299',
        HOSTER_NAS_USER: 'envuser',
        HOSTER_BASE_DOMAIN: 'env.example.com',
        HOSTER_CF_API_TOKEN: 'env-token',
        HOSTER_CF_ACCOUNT_ID: CF_ACCOUNT,
        HOSTER_CF_ZONE_ID: CF_ZONE,
        HOSTER_GHCR_PAT: 'env-pat',
      },
      existing: existingConfig(),
    });

    const s = await promise;
    expect(s.nas).toEqual({ host: '10.0.0.9', port: 2299, user: 'envuser' });
    expect(s.baseDomain).toBe('env.example.com');
    expect(s.cloudflare.apiToken).toBe('env-token');
    expect(s.ghcrPat).toBe('env-pat');
  });

  it('비대화형에서 값이 없으면 옵션명과 환경변수명을 함께 알려주는 에러를 던진다', async () => {
    const { promise } = resolve({ interactive: false });

    await expect(promise).rejects.toThrow(/--nas-host/);
    await expect(resolve({ interactive: false }).promise).rejects.toThrow(/HOSTER_NAS_HOST/);
  });

  it('비대화형이어도 기존 설정이 있으면 묻지 않고 그대로 사용한다', async () => {
    const { promise, io } = resolve({ interactive: false, existing: existingConfig() });

    const s = await promise;
    expect(s.nas).toEqual({ host: '192.168.10.11', port: 20022, user: 'super' });
    expect(s.baseDomain).toBe('tlog.net');
    expect(s.cloudflare.apiToken).toBe('old-token');
    expect(io.ask).not.toHaveBeenCalled();
    expect(io.askHidden).not.toHaveBeenCalled();
  });
});

describe('resolveInitSettings — 대화형 프롬프트', () => {
  it('값이 없으면 프롬프트로 묻는다', async () => {
    const io = makeIo(
      {
        '기본 도메인': 'example.com',
        'NAS 호스트': '192.168.0.2',
        'NAS SSH 포트': '2222',
        'NAS 사용자': 'admin',
        'Account ID': CF_ACCOUNT,
        'Zone ID': CF_ZONE,
      },
      { 'API 토큰': 'typed-token', GHCR: 'typed-pat' }
    );
    const { promise } = resolve({ interactive: true, io });

    const s = await promise;
    expect(s.nas).toEqual({ host: '192.168.0.2', port: 2222, user: 'admin' });
    expect(s.baseDomain).toBe('example.com');
    expect(s.cloudflare).toEqual({ apiToken: 'typed-token', accountId: CF_ACCOUNT, zoneId: CF_ZONE });
    expect(s.ghcrPat).toBe('typed-pat');
  });

  it('기존 설정 값을 프롬프트 기본값으로 보여주고, 빈 입력이면 그 값을 채택한다', async () => {
    const io = makeIo();
    const { promise } = resolve({ interactive: true, existing: existingConfig(), io });

    const s = await promise;
    expect(s.nas).toEqual({ host: '192.168.10.11', port: 20022, user: 'super' });
    expect(s.baseDomain).toBe('tlog.net');
    // 기본값이 프롬프트 문구에 보여야 사용자가 엔터로 채택할 수 있다.
    expect(io.asked.join('\n')).toContain('192.168.10.11');
    expect(io.asked.join('\n')).toContain('tlog.net');
  });

  it('시크릿은 숨김 프롬프트로 받고, 기존 값은 화면에 노출하지 않는다', async () => {
    const io = makeIo();
    const { promise } = resolve({ interactive: true, existing: existingConfig(), io });

    const s = await promise;
    // 빈 입력이므로 기존 시크릿이 유지된다.
    expect(s.cloudflare.apiToken).toBe('old-token');
    expect(s.ghcrPat).toBe('old-ghcr-pat');
    // 시크릿 값 자체는 프롬프트 문구에도 로그에도 남으면 안 된다.
    const shown = [...io.asked, ...io.askedHidden, ...io.logs].join('\n');
    expect(shown).not.toContain('old-token');
    expect(shown).not.toContain('old-ghcr-pat');
    expect(shown).not.toContain('old-hmac-secret');
    // 대신 엔터로 유지할 수 있다는 사실은 알려줘야 한다.
    expect(io.askedHidden.join('\n')).toMatch(/기존 값 유지/);
  });

  it('시크릿을 일반 프롬프트(ask)로 묻지 않는다', async () => {
    const io = makeIo(
      {
        '기본 도메인': 'example.com',
        'NAS 호스트': '192.168.0.2',
        'NAS SSH 포트': '2222',
        'NAS 사용자': 'admin',
        'Account ID': CF_ACCOUNT,
        'Zone ID': CF_ZONE,
      },
      { 'API 토큰': 'typed-token', GHCR: 'typed-pat' }
    );
    await resolve({ interactive: true, io }).promise;

    expect(io.asked.join('\n')).not.toMatch(/토큰|PAT/);
  });

  it('잘못된 입력은 다시 묻는다', async () => {
    const hostAnswers = ['', 'bad host!', '192.168.0.2'];
    const io = makeIo(
      {
        '기본 도메인': 'example.com',
        'NAS SSH 포트': '2222',
        'NAS 사용자': 'admin',
        'Account ID': CF_ACCOUNT,
        'Zone ID': CF_ZONE,
      },
      { 'API 토큰': 'typed-token', GHCR: 'typed-pat' }
    );
    io.ask.mockImplementation(async (q: string) => {
      io.asked.push(q);
      if (q.includes('NAS 호스트')) return hostAnswers.shift() ?? '';
      if (q.includes('기본 도메인')) return 'example.com';
      if (q.includes('NAS SSH 포트')) return '2222';
      if (q.includes('NAS 사용자')) return 'admin';
      if (q.includes('Account ID')) return CF_ACCOUNT;
      if (q.includes('Zone ID')) return CF_ZONE;
      return '';
    });
    const { promise } = resolve({ interactive: true, io });

    const s = await promise;
    expect(s.nas.host).toBe('192.168.0.2');
    expect(io.asked.filter((q) => q.includes('NAS 호스트'))).toHaveLength(3);
  });

  it('계속 잘못 입력하면 중단한다', async () => {
    const io = makeIo({ 'NAS 호스트': 'bad host!' });
    const { promise } = resolve({ interactive: true, io });

    await expect(promise).rejects.toThrow(/NAS 호스트/);
  });
});

describe('resolveInitSettings — 값 검증', () => {
  it('잘못된 포트는 옵션 이름과 함께 거부한다', async () => {
    const base = { nasHost: '10.0.0.5', nasUser: 'deploy', baseDomain: 'a.example.com' };
    for (const bad of ['0', '70000', 'abc', '-1', '22.5']) {
      const { promise } = resolve({ cli: { ...base, nasPort: bad } });
      await expect(promise).rejects.toThrow(/--nas-port/);
    }
  });

  it('잘못된 기본 도메인을 거부한다', async () => {
    for (const bad of ['example', 'ex ample.com', 'http://example.com', '-bad.com', 'exam_ple.com']) {
      const { promise } = resolve({ cli: { nasHost: '10.0.0.5', nasUser: 'd', baseDomain: bad } });
      await expect(promise).rejects.toThrow(/--base-domain/);
    }
  });

  it('기본 도메인 대문자는 소문자로 정규화한다', async () => {
    const { promise } = resolve({
      cli: { nasHost: '10.0.0.5', nasUser: 'd', baseDomain: 'Example.COM' },
      env: { HOSTER_CF_API_TOKEN: 't', HOSTER_CF_ACCOUNT_ID: CF_ACCOUNT, HOSTER_CF_ZONE_ID: CF_ZONE, HOSTER_GHCR_PAT: 'p' },
    });

    expect((await promise).baseDomain).toBe('example.com');
  });

  it('Cloudflare Account/Zone ID는 32자리 hex만 받는다', async () => {
    const { promise } = resolve({
      cli: { nasHost: '10.0.0.5', nasUser: 'd', baseDomain: 'a.example.com', cfAccountId: 'not-an-id' },
      env: { HOSTER_CF_API_TOKEN: 't', HOSTER_CF_ZONE_ID: CF_ZONE, HOSTER_GHCR_PAT: 'p' },
    });

    await expect(promise).rejects.toThrow(/--cf-account-id/);
  });

  it('셸 메타문자가 든 NAS 호스트/사용자를 거부한다', async () => {
    for (const bad of ['1.2.3.4; rm -rf /', '$(whoami)', "a'b", '`id`']) {
      await expect(
        resolve({ cli: { nasHost: bad, nasUser: 'd', baseDomain: 'a.example.com' } }).promise
      ).rejects.toThrow(/--nas-host/);
      await expect(
        resolve({ cli: { nasHost: '10.0.0.5', nasUser: bad, baseDomain: 'a.example.com' } }).promise
      ).rejects.toThrow(/--nas-user/);
    }
  });

  it('환경변수 값이 잘못되면 환경변수 이름을 알려준다', async () => {
    const { promise } = resolve({ env: { HOSTER_NAS_PORT: 'abc', HOSTER_NAS_HOST: '10.0.0.5' } });

    await expect(promise).rejects.toThrow(/HOSTER_NAS_PORT/);
  });

  it('NAS SSH 포트는 값이 없으면 22를 기본값으로 쓴다', async () => {
    const { promise } = resolve({
      cli: { nasHost: '10.0.0.5', nasUser: 'd', baseDomain: 'a.example.com' },
      env: { HOSTER_CF_API_TOKEN: 't', HOSTER_CF_ACCOUNT_ID: CF_ACCOUNT, HOSTER_CF_ZONE_ID: CF_ZONE, HOSTER_GHCR_PAT: 'p' },
    });

    expect((await promise).nas.port).toBe(22);
  });
});

describe('resolveInitSettings — HMAC_SECRET 재실행 안전성', () => {
  const cliAll: InitCliOptions = {
    nasHost: '10.0.0.5',
    nasPort: '22',
    nasUser: 'deploy',
    baseDomain: 'a.example.com',
    cfAccountId: CF_ACCOUNT,
    cfZoneId: CF_ZONE,
  };
  const envSecrets = { HOSTER_CF_API_TOKEN: 't', HOSTER_GHCR_PAT: 'p' };

  it('기존 설정이 없으면 새로 생성한다', async () => {
    const s = await resolve({ cli: cliAll, env: envSecrets }).promise;

    expect(s.hmacSecret).toBe('new-hmac-secret');
    expect(s.hmacRotated).toBe(true);
  });

  it('기존 설정이 있고 비대화형이면 기존 시크릿을 유지하고 그 사실을 알린다', async () => {
    const io = makeIo();
    const s = await resolve({ cli: cliAll, env: envSecrets, existing: existingConfig(), io }).promise;

    expect(s.hmacSecret).toBe('old-hmac-secret');
    expect(s.hmacRotated).toBe(false);
    expect(io.logs.join('\n')).toMatch(/HMAC_SECRET/);
    // 유지 사실을 알리더라도 값 자체는 노출하지 않는다.
    expect(io.logs.join('\n')).not.toContain('old-hmac-secret');
  });

  it('--rotate-hmac을 지정하면 기존 설정이 있어도 새로 생성한다', async () => {
    const io = makeIo();
    const s = await resolve({
      cli: { ...cliAll, rotateHmac: true },
      env: envSecrets,
      existing: existingConfig(),
      interactive: true,
      io,
    }).promise;

    expect(s.hmacSecret).toBe('new-hmac-secret');
    expect(s.hmacRotated).toBe(true);
    // 플래그로 이미 결정했으므로 묻지 않는다.
    expect(io.asked.join('\n')).not.toMatch(/HMAC/);
  });

  it('대화형이면 재생성 여부를 묻고 기본값(빈 입력)은 유지다', async () => {
    const io = makeIo();
    const s = await resolve({ cli: cliAll, env: envSecrets, existing: existingConfig(), interactive: true, io })
      .promise;

    expect(io.asked.join('\n')).toMatch(/HMAC_SECRET/);
    expect(s.hmacSecret).toBe('old-hmac-secret');
    expect(s.hmacRotated).toBe(false);
  });

  it('대화형에서 y를 입력하면 재생성하고 재등록이 필요함을 경고한다', async () => {
    const io = makeIo({ HMAC_SECRET: 'y' });
    const s = await resolve({ cli: cliAll, env: envSecrets, existing: existingConfig(), interactive: true, io })
      .promise;

    expect(s.hmacSecret).toBe('new-hmac-secret');
    expect(s.hmacRotated).toBe(true);
    expect(io.logs.join('\n')).toMatch(/HOSTER_DEPLOY_SECRET/);
  });
});

describe('resolveInitSettings — dry-run', () => {
  it('includeCredentials가 false면 시크릿/Cloudflare ID를 묻지 않는다', async () => {
    const io = makeIo({ '기본 도메인': 'example.com', 'NAS 호스트': '192.168.0.2', 'NAS 사용자': 'admin' });
    const s = await resolve({ interactive: true, includeCredentials: false, io }).promise;

    expect(s.baseDomain).toBe('example.com');
    expect(s.nas.host).toBe('192.168.0.2');
    expect(io.askHidden).not.toHaveBeenCalled();
    expect(io.asked.join('\n')).not.toMatch(/Account ID|Zone ID/);
    // 계획에는 시크릿이 들어가지 않으므로 빈 값이어야 한다.
    expect(s.cloudflare.apiToken).toBe('');
    expect(s.hmacSecret).toBe('');
  });

  it('묻지는 않더라도, 명시적으로 준 Cloudflare ID가 잘못되면 dry-run에서도 알려준다', async () => {
    const { promise } = resolve({
      cli: { nasHost: '10.0.0.5', nasUser: 'd', baseDomain: 'a.example.com', cfZoneId: 'nope' },
      includeCredentials: false,
    });

    await expect(promise).rejects.toThrow(/--cf-zone-id/);
  });
});
