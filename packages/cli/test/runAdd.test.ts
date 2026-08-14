import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { runAdd, loadTemplate, type AddDeps, type AddFs, type ExecResult } from '../src/commands/add.js';
import type { HosterConfig } from '../src/config.js';

const CWD = '/repo';

const config: HosterConfig = {
  nas: { host: '192.168.1.100', port: 2222, user: 'admin' },
  cloudflare: { apiToken: 'cf-api-token-value', zoneId: 'zone-id', accountId: 'acc-id', tunnelId: 'tunnel-abc' },
  baseDomain: 'example.com',
  deployerUrl: 'https://hoster.example.com',
  hmacSecret: 'hmac-secret-hex-value',
  ghcrPat: 'ghcr-pat-value',
};

function makeFakeFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const mkdirCalls: string[] = [];
  const writeCalls: Array<{ path: string; content: string }> = [];
  const fs: AddFs = {
    exists: (p) => files.has(p),
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`no such file: ${p}`);
      return v;
    },
    writeFile: (p, c) => {
      files.set(p, c);
      writeCalls.push({ path: p, content: c });
    },
    mkdir: (p) => {
      mkdirCalls.push(p);
    },
  };
  return { fs, files, mkdirCalls, writeCalls };
}

type RunCall = { cmd: string; args: string[]; opts?: { cwd?: string; input?: string } };

function baseDeps(overrides: {
  fsInitial?: Record<string, string>;
  runImpl?: (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => Promise<ExecResult> | ExecResult;
} = {}) {
  const { fs, files, mkdirCalls, writeCalls } = makeFakeFs(
    overrides.fsInitial ?? {
      [join(CWD, 'package.json')]: JSON.stringify({ dependencies: { next: '15.0.0' } }),
    }
  );
  const logs: string[] = [];
  const warns: string[] = [];

  const cfCalls: Array<{ method: string; args: unknown[] }> = [];
  const cf = { upsertDnsCname: vi.fn(async (...args: unknown[]) => { cfCalls.push({ method: 'upsertDnsCname', args }); }) };

  const clientCalls: Array<{ method: string; args: unknown[] }> = [];
  const client = { registerProject: vi.fn(async (...args: unknown[]) => { clientCalls.push({ method: 'registerProject', args }); }) };

  const runCalls: RunCall[] = [];
  const defaultRunImpl = async (cmd: string, args: string[], opts?: { cwd?: string; input?: string }): Promise<ExecResult> => {
    if (cmd === 'git' && args[0] === 'remote') return { code: 0, stdout: 'git@github.com:Foo/Bar-App.git\n', stderr: '' };
    if (cmd === 'gh' && args[0] === '--version') return { code: 0, stdout: 'gh version 2.0.0', stderr: '' };
    if (cmd === 'gh' && args[0] === 'auth') return { code: 0, stdout: 'Logged in to github.com', stderr: '' };
    if (cmd === 'gh' && args[0] === 'secret') return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const runImpl = overrides.runImpl ?? defaultRunImpl;
  const run = vi.fn(async (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => {
    runCalls.push({ cmd, args, opts });
    return runImpl(cmd, args, opts);
  });

  const loadTemplate = vi.fn((name: string) => {
    if (name === 'Dockerfile.nextjs.tpl') return 'FROM node:22-alpine\n# nextjs dockerfile template\n';
    if (name === 'workflow.yml.tpl') return 'branch={{BRANCH}} project={{PROJECT}} image={{IMAGE_REPO}}\n';
    throw new Error(`unknown template: ${name}`);
  });

  const deps: AddDeps = {
    run,
    fs,
    loadConfig: vi.fn(() => config),
    loadTemplate,
    makeCloudflare: vi.fn(() => cf),
    makeClient: vi.fn(() => client),
    log: vi.fn((m: string) => logs.push(m)),
    warn: vi.fn((m: string) => warns.push(m)),
  };

  return { deps, fs, files, mkdirCalls, writeCalls, logs, warns, cf, cfCalls, client, clientCalls, runCalls, run };
}

describe('runAdd — dry-run', () => {
  it('아무 파일도 쓰지 않고 gh/API를 호출하지 않은 채 계획만 출력한다', async () => {
    const { deps, files, cf, client, runCalls, logs } = baseDeps();
    const initialSize = files.size;

    await runAdd({ branch: 'main', cwd: CWD, dryRun: true, deps });

    expect(files.size).toBe(initialSize); // 새로 쓰인 파일 없음
    expect(runCalls.some((c) => c.cmd === 'gh')).toBe(false);
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(cf.upsertDnsCname).not.toHaveBeenCalled();
    expect(client.registerProject).not.toHaveBeenCalled();
    expect(logs.length).toBeGreaterThan(0);
    // dry-run 출력에도 이미지 저장소가 소문자로 계산되어 나타나야 한다 (사전 확인 가치).
    expect(logs.join('\n')).toContain('ghcr.io/foo/bar-app');
  });
});

describe('runAdd — gh 사전 점검', () => {
  it('gh CLI가 없으면 설치 안내 에러를 던지고 아무 파일도 쓰지 않는다', async () => {
    const { deps, files, runCalls } = baseDeps({
      runImpl: async (cmd, args) => {
        if (cmd === 'git') return { code: 0, stdout: 'git@github.com:Foo/Bar-App.git\n', stderr: '' };
        if (cmd === 'gh' && args[0] === '--version') return { code: 127, stdout: '', stderr: 'command not found' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const initialSize = files.size;

    await expect(runAdd({ branch: 'main', cwd: CWD, dryRun: false, deps })).rejects.toThrow(/설치/);

    expect(files.size).toBe(initialSize); // Dockerfile/workflow 모두 쓰이지 않음
    expect(deps.loadConfig).not.toHaveBeenCalled();
    expect(runCalls.some((c) => c.cmd === 'gh' && c.args[0] === 'secret')).toBe(false);
  });

  it('gh 인증이 안 되어 있으면 로그인 안내 에러를 던지고 아무 파일도 쓰지 않는다', async () => {
    const { deps, files } = baseDeps({
      runImpl: async (cmd, args) => {
        if (cmd === 'git') return { code: 0, stdout: 'git@github.com:Foo/Bar-App.git\n', stderr: '' };
        if (cmd === 'gh' && args[0] === '--version') return { code: 0, stdout: 'gh version 2.0.0', stderr: '' };
        if (cmd === 'gh' && args[0] === 'auth') return { code: 1, stdout: '', stderr: 'not logged in' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const initialSize = files.size;

    await expect(runAdd({ branch: 'main', cwd: CWD, dryRun: false, deps })).rejects.toThrow(/gh auth login/);

    expect(files.size).toBe(initialSize);
    expect(deps.loadConfig).not.toHaveBeenCalled();
  });
});

describe('runAdd — 전체 실행 (Next.js 프로젝트, 대소문자 섞인 저장소)', () => {
  it('Dockerfile 생성, workflow 렌더링, gh secret 설정(stdin), DNS/프로젝트 등록까지 수행한다', async () => {
    const { deps, files, cfCalls, clientCalls, runCalls, logs, warns, mkdirCalls } = baseDeps();

    await runAdd({ branch: 'main', cwd: CWD, dryRun: false, deps });

    // Dockerfile 생성 (Next.js 감지)
    expect(files.get(join(CWD, 'Dockerfile'))).toContain('nextjs dockerfile template');
    // next.config가 아예 없으므로 standalone 경고가 출력된다.
    expect(warns.some((w) => w.includes('standalone'))).toBe(true);

    // workflow 렌더링: 대소문자가 섞인 저장소(Foo/Bar-App)라도 이미지 경로는 소문자.
    const workflowPath = join(CWD, '.github', 'workflows', 'hoster-deploy.yml');
    expect(files.get(workflowPath)).toBe('branch=main project=bar-app image=ghcr.io/foo/bar-app\n');
    expect(mkdirCalls).toContain(join(CWD, '.github', 'workflows'));

    // gh secret set: 값은 인자가 아니라 stdin으로 전달되고, 인자 목록에 값이 노출되지 않는다.
    const urlSecret = runCalls.find((c) => c.cmd === 'gh' && c.args.includes('HOSTER_DEPLOY_URL'));
    const hmacSecretCall = runCalls.find((c) => c.cmd === 'gh' && c.args.includes('HOSTER_DEPLOY_SECRET'));
    expect(urlSecret?.opts?.input).toBe(config.deployerUrl);
    expect(hmacSecretCall?.opts?.input).toBe(config.hmacSecret);
    expect(urlSecret?.args.join(' ')).not.toContain(config.deployerUrl);
    expect(hmacSecretCall?.args.join(' ')).not.toContain(config.hmacSecret);
    expect(urlSecret?.args).toContain('--repo');
    expect(urlSecret?.args).toContain('Foo/Bar-App');

    // DNS/등록
    expect(cfCalls[0]).toEqual({ method: 'upsertDnsCname', args: ['bar-app.example.com', 'tunnel-abc.cfargotunnel.com'] });
    expect(clientCalls[0]).toEqual({
      method: 'registerProject',
      args: [{ name: 'bar-app', imageRepo: 'ghcr.io/foo/bar-app', branch: 'main' }],
    });

    // 마무리 안내 메시지
    expect(logs.some((l) => l.includes('git add Dockerfile .github && git commit && git push'))).toBe(true);

    // 시크릿 실제 값은 어떤 log/warn 호출에도 노출되지 않는다.
    const joined = [...logs, ...warns].join('\n');
    expect(joined).not.toContain(config.hmacSecret);
    expect(joined).not.toContain(config.cloudflare.apiToken);
  });

  it('--project 옵션을 지정하면 자동 생성 대신 그 값을 프로젝트명/도메인/등록에 사용한다', async () => {
    const { deps, cfCalls, clientCalls } = baseDeps();

    await runAdd({ branch: 'main', project: 'custom-name', cwd: CWD, dryRun: false, deps });

    expect(cfCalls[0].args[0]).toBe('custom-name.example.com');
    expect((clientCalls[0].args[0] as { name: string }).name).toBe('custom-name');
  });

  it('Dockerfile이 이미 있으면 새로 생성하지 않는다', async () => {
    const { deps, files, writeCalls } = baseDeps({
      fsInitial: {
        [join(CWD, 'package.json')]: JSON.stringify({ dependencies: { next: '15.0.0' } }),
        [join(CWD, 'Dockerfile')]: 'FROM my-existing-base\n',
      },
    });

    await runAdd({ branch: 'main', cwd: CWD, dryRun: false, deps });

    expect(files.get(join(CWD, 'Dockerfile'))).toBe('FROM my-existing-base\n');
    expect(writeCalls.some((w) => w.path === join(CWD, 'Dockerfile'))).toBe(false);
  });

  it('Next.js가 아니고 Dockerfile도 없으면 경고만 출력하고 자동 생성하지 않는다', async () => {
    const { deps, files, warns } = baseDeps({
      fsInitial: { [join(CWD, 'package.json')]: JSON.stringify({ dependencies: { express: '4.0.0' } }) },
    });

    await runAdd({ branch: 'main', cwd: CWD, dryRun: false, deps });

    expect(files.has(join(CWD, 'Dockerfile'))).toBe(false);
    expect(warns.some((w) => w.includes('Dockerfile'))).toBe(true);
  });

  it('next.config에 standalone 설정이 이미 있으면 경고하지 않는다', async () => {
    const { deps, warns } = baseDeps({
      fsInitial: {
        [join(CWD, 'package.json')]: JSON.stringify({ dependencies: { next: '15.0.0' } }),
        [join(CWD, 'next.config.js')]: "module.exports = { output: 'standalone' }\n",
      },
    });

    await runAdd({ branch: 'main', cwd: CWD, dryRun: false, deps });

    expect(warns.some((w) => w.includes('standalone'))).toBe(false);
  });
});

describe('runAdd — branch/project 검증 (fix round 2)', () => {
  // MUST-FIX/IMPORTANT 리뷰 지시: branch/project는 workflow.yml.tpl에 YAML 문자열과 셸
  // 이중따옴표 문자열(printf 안) 양쪽으로 삽입된다 — 어떤 파일도 쓰기 전에 거부돼야 한다.
  it('--branch에 셸 메타문자가 있으면 파일을 쓰기 전에 에러를 던진다', async () => {
    const { deps, files } = baseDeps();
    const initialSize = files.size;

    await expect(
      runAdd({ branch: 'main"; rm -rf /; echo "', cwd: CWD, dryRun: false, deps })
    ).rejects.toThrow(/브랜치/);

    expect(files.size).toBe(initialSize);
    expect(deps.loadConfig).not.toHaveBeenCalled();
  });

  it('--project에 허용되지 않는 문자가 있으면 파일을 쓰기 전에 에러를 던진다', async () => {
    const { deps, files } = baseDeps();
    const initialSize = files.size;

    await expect(
      runAdd({ branch: 'main', project: 'proj"; rm -rf /; echo "', cwd: CWD, dryRun: false, deps })
    ).rejects.toThrow(/프로젝트명/);

    expect(files.size).toBe(initialSize);
    expect(deps.loadConfig).not.toHaveBeenCalled();
  });

  it('--project에 대문자가 있으면 (서버 PROJECT_NAME_RE 위반) 거부한다', async () => {
    const { deps, files } = baseDeps();
    const initialSize = files.size;

    await expect(
      runAdd({ branch: 'main', project: 'Invalid-Name', cwd: CWD, dryRun: false, deps })
    ).rejects.toThrow(/프로젝트명/);

    expect(files.size).toBe(initialSize);
  });
});

describe('runAdd — 기존 workflow 파일 보호 (fix round 1)', () => {
  it('.github/workflows/hoster-deploy.yml이 이미 있으면 덮어쓰지 않고 안내만 출력한다', async () => {
    const workflowPath = join(CWD, '.github', 'workflows', 'hoster-deploy.yml');
    const { deps, files, writeCalls, logs } = baseDeps({
      fsInitial: {
        [join(CWD, 'package.json')]: JSON.stringify({ dependencies: { next: '15.0.0' } }),
        [join(CWD, 'Dockerfile')]: 'FROM my-existing-base\n',
        [workflowPath]: 'name: my custom workflow\n',
      },
    });

    await runAdd({ branch: 'main', cwd: CWD, dryRun: false, deps });

    expect(files.get(workflowPath)).toBe('name: my custom workflow\n'); // 그대로 유지
    expect(writeCalls.some((w) => w.path === workflowPath)).toBe(false);
    expect(logs.some((l) => l.includes(workflowPath) || l.includes('hoster-deploy.yml'))).toBe(true);
    expect(logs.some((l) => l.includes('--force'))).toBe(true);
  });

  it('--force를 지정하면 기존 workflow 파일을 덮어쓴다', async () => {
    const workflowPath = join(CWD, '.github', 'workflows', 'hoster-deploy.yml');
    const { deps, files } = baseDeps({
      fsInitial: {
        [join(CWD, 'package.json')]: JSON.stringify({ dependencies: { next: '15.0.0' } }),
        [join(CWD, 'Dockerfile')]: 'FROM my-existing-base\n',
        [workflowPath]: 'name: my custom workflow\n',
      },
    });

    await runAdd({ branch: 'main', cwd: CWD, dryRun: false, force: true, deps });

    expect(files.get(workflowPath)).toBe('branch=main project=bar-app image=ghcr.io/foo/bar-app\n');
  });
});

describe('runAdd — DNS/등록 부분 실패 안내 (fix round 1)', () => {
  it('DNS는 생성됐지만 프로젝트 등록이 실패하면, 재시도 방법을 안내하고 원본 에러를 던진다', async () => {
    const { deps, logs, warns, cfCalls, client } = baseDeps();
    (client.registerProject as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('deployer 응답 500: internal error');
    });

    await expect(runAdd({ branch: 'main', cwd: CWD, dryRun: false, deps })).rejects.toThrow(/internal error/);

    expect(cfCalls).toHaveLength(1); // DNS는 실제로 생성 시도됨
    expect(client.registerProject).toHaveBeenCalledTimes(1);
    const joined = [...logs, ...warns].join('\n');
    expect(joined).toMatch(/DNS/);
    expect(joined).toMatch(/bar-app\.example\.com/);
    expect(joined).not.toContain(config.hmacSecret);
    expect(joined).not.toContain(config.cloudflare.apiToken);
  });

  it('DNS 생성 자체가 실패하면 프로젝트 등록은 시도하지 않고, 이미 완료된 단계를 안내한 뒤 원본 에러를 던진다', async () => {
    const { deps, logs, warns, client, cf } = baseDeps();
    (cf.upsertDnsCname as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('Cloudflare API 실패: rate limited');
    });

    await expect(runAdd({ branch: 'main', cwd: CWD, dryRun: false, deps })).rejects.toThrow(/rate limited/);

    expect(client.registerProject).not.toHaveBeenCalled();
    const joined = [...logs, ...warns].join('\n');
    expect(joined).toMatch(/DNS/);
    expect(joined).not.toContain(config.hmacSecret);
    expect(joined).not.toContain(config.cloudflare.apiToken);
  });
});

// loadTemplate은 소스(vitest) 실행 시 모노레포 루트 templates/를, 빌드된 dist 실행 시
// dist/templates(빌드 스크립트가 복사)를 찾는다 — 여기서는 실제 소스 실행 경로를 검증한다.
describe('loadTemplate — 실제 템플릿 파일 로드', () => {
  it('workflow.yml.tpl 원본을 로드할 수 있다', () => {
    const content = loadTemplate('workflow.yml.tpl');
    expect(content).toContain('{{BRANCH}}');
    expect(content).toContain('{{IMAGE_REPO}}');
  });

  it('Dockerfile.nextjs.tpl 원본을 로드할 수 있다', () => {
    const content = loadTemplate('Dockerfile.nextjs.tpl');
    expect(content).toContain('FROM node:22-alpine');
  });
});
