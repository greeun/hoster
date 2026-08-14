import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cloudflare } from '../cloudflare.js';
import { DeployerClient } from '../client.js';
import { loadConfig, type HosterConfig } from '../config.js';
import {
  parseGitHubRepo,
  projectNameOf,
  imageRepoOf,
  renderTemplate,
  detectNextJs,
  isValidBranchName,
  isValidProjectName,
} from '../repo.js';
import { withSpinner, type ProgressIo } from '../progress.js';

const DOCKERFILE_NAME = 'Dockerfile';
const WORKFLOW_REL_PATH = '.github/workflows/hoster-deploy.yml';
// next.config 파일은 프로젝트마다 확장자가 다를 수 있어 후보를 모두 확인한다.
const NEXT_CONFIG_CANDIDATES = ['next.config.js', 'next.config.mjs', 'next.config.ts', 'next.config.cjs'];

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

// git/gh 실행을 모두 이 타입으로 추상화한다 — 테스트는 이 러너를 주입해
// 실제 git/gh 없이 runAdd의 오케스트레이션을 검증한다.
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; input?: string }) => Promise<ExecResult>;

export interface AddFs {
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdir(path: string): void;
}

export interface AddDeps {
  run?: Runner;
  fs?: AddFs;
  progressIo?: ProgressIo;
  loadConfig?: () => HosterConfig;
  loadTemplate?: (name: string) => string;
  makeCloudflare?: (opts: {
    apiToken: string;
    accountId: string;
    zoneId: string;
  }) => Pick<Cloudflare, 'upsertDnsCname'>;
  makeClient?: (opts: { baseUrl: string; secret: string }) => Pick<DeployerClient, 'registerProject'>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

export interface AddOptions {
  branch: string;
  project?: string;
  cwd: string;
  dryRun: boolean;
  // 이미 존재하는 .github/workflows/hoster-deploy.yml을 덮어쓸지 여부.
  // 기본값(false)에서는 사용자가 수정한 workflow 파일을 보존한다.
  force?: boolean;
  deps?: AddDeps;
}

function exitCodeOf(err: (Error & { code?: unknown }) | null): number {
  if (!err) return 0;
  return typeof err.code === 'number' ? err.code : 1;
}

// gh secret set 등 시크릿을 다루는 호출은 값을 인자(argv)로 넘기지 않고 stdin으로
// 전달한다 — argv는 `ps` 등으로 다른 사용자에게 노출될 수 있으나 stdin은 그렇지 않다.
const defaultRun: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd: opts?.cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: exitCodeOf(err), stdout, stderr });
    });
    if (opts?.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });

const defaultFs: AddFs = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, 'utf-8'),
  writeFile: (p, c) => writeFileSync(p, c),
  mkdir: (p) => mkdirSync(p, { recursive: true }),
};

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// 빌드된 dist(packages/cli/dist/commands/add.js)에서는 `cp -r ../../templates dist/templates`로
// 복사된 dist/templates를 사용하고, 소스(vitest 등)에서 직접 실행될 때는 모노레포 루트의
// templates/를 그대로 참조한다 — 두 경로 모두 시도해 존재하는 첫 번째를 사용한다.
function resolveTemplatePath(name: string): string {
  const candidates = [
    join(MODULE_DIR, '..', 'templates', name),
    join(MODULE_DIR, '..', '..', '..', '..', 'templates', name),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    throw new Error(`템플릿을 찾을 수 없습니다: ${name} (확인한 경로: ${candidates.join(', ')})`);
  }
  return found;
}

export function loadTemplate(name: string): string {
  return readFileSync(resolveTemplatePath(name), 'utf-8');
}

async function ensureGhReady(run: Runner, cwd: string): Promise<void> {
  const version = await run('gh', ['--version'], { cwd });
  if (version.code !== 0) {
    throw new Error('GitHub CLI(gh)가 설치되어 있지 않습니다. https://cli.github.com/ 에서 설치한 뒤 다시 실행하세요.');
  }
  const auth = await run('gh', ['auth', 'status'], { cwd });
  if (auth.code !== 0) {
    throw new Error('gh CLI에 로그인되어 있지 않습니다. `gh auth login` 을 실행한 뒤 다시 시도하세요.');
  }
}

export async function runAdd(opts: AddOptions): Promise<void> {
  const deps = opts.deps ?? {};
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.error(m));
  const run = deps.run ?? defaultRun;
  const fs = deps.fs ?? defaultFs;
  const loadTpl = deps.loadTemplate ?? loadTemplate;

  const remote = await run('git', ['remote', 'get-url', 'origin'], { cwd: opts.cwd });
  if (remote.code !== 0) {
    throw new Error(`git 원격(origin) 조회 실패: ${remote.stderr || remote.stdout}`);
  }
  const { owner, repo } = parseGitHubRepo(remote.stdout);
  const projectName = opts.project ?? projectNameOf(repo);
  const imageRepo = imageRepoOf(owner, repo);

  // IMPORTANT (리뷰 지시): branch/project는 templates/workflow.yml.tpl에 YAML 문자열과
  // 셸 이중따옴표 문자열(printf 안) 양쪽으로 그대로 삽입되므로, 어떤 파일도 쓰기 전에
  // 반드시 검증한다. --project는 projectNameOf()를 거치지 않는 유일한 경로라 특히 중요하다.
  if (!isValidBranchName(opts.branch)) {
    throw new Error(`유효하지 않은 브랜치명입니다: "${opts.branch}"`);
  }
  if (!isValidProjectName(projectName)) {
    throw new Error(
      `유효하지 않은 프로젝트명입니다: "${projectName}" (허용 형식: 소문자/숫자/하이픈, 63자 이하, 첫 글자는 영숫자)`
    );
  }

  const dockerfilePath = join(opts.cwd, DOCKERFILE_NAME);
  const pkgJsonPath = join(opts.cwd, 'package.json');
  const workflowPath = join(opts.cwd, WORKFLOW_REL_PATH);
  const hasDockerfile = fs.exists(dockerfilePath);
  const hasWorkflow = fs.exists(workflowPath);
  const isNextJs = fs.exists(pkgJsonPath) && detectNextJs(fs.readFile(pkgJsonPath));

  if (opts.dryRun) {
    log('--dry-run: 아래 작업을 실행하지 않고 계획만 표시합니다.');
    log(`1. 프로젝트 "${projectName}" (${owner}/${repo}), 이미지 저장소 "${imageRepo}"`);
    if (hasDockerfile) {
      log('2. Dockerfile 이미 존재 — 생성 건너뜀');
    } else if (isNextJs) {
      log('2. Next.js 감지 — Dockerfile 생성 예정 (templates/Dockerfile.nextjs.tpl)');
    } else {
      log('2. Dockerfile 없음, Next.js 아님 — 자동 생성하지 않음 (직접 추가 필요)');
    }
    if (hasWorkflow && !opts.force) {
      log(`3. ${WORKFLOW_REL_PATH} 이미 존재 — 덮어쓰지 않고 건너뜀 (덮어쓰려면 --force)`);
    } else {
      log(`3. ${WORKFLOW_REL_PATH} 생성 예정 (branch=${opts.branch}, project=${projectName})`);
    }
    log('4. gh secret set HOSTER_DEPLOY_URL / HOSTER_DEPLOY_SECRET 설정 예정');
    log(`5. DNS CNAME 설정 예정: ${projectName}.<baseDomain> -> <tunnelId>.cfargotunnel.com`);
    log(`6. 프로젝트 등록 예정: registerProject({ name: "${projectName}", imageRepo: "${imageRepo}", branch: "${opts.branch}" })`);
    return;
  }

  // gh 사전 점검을 가장 먼저 수행한다 — 이후 단계(Dockerfile/workflow 파일 생성 등)가
  // 이미 실행된 뒤 gh가 없어서 중단되면 저장소가 "반쯤 설정된" 상태로 남기 때문이다.
  await ensureGhReady(run, opts.cwd);

  const config = (deps.loadConfig ?? loadConfig)();

  if (!hasDockerfile) {
    if (isNextJs) {
      fs.writeFile(dockerfilePath, loadTpl('Dockerfile.nextjs.tpl'));
      const nextConfigPath = NEXT_CONFIG_CANDIDATES.map((f) => join(opts.cwd, f)).find((p) => fs.exists(p));
      const nextConfigContent = nextConfigPath ? fs.readFile(nextConfigPath) : '';
      if (!nextConfigContent.includes('standalone')) {
        warn("next.config에 output: 'standalone' 설정이 없습니다 — 추가가 필요합니다.");
      }
    } else {
      warn('Dockerfile이 없고 Next.js 프로젝트가 아닙니다 — 직접 Dockerfile을 추가하세요.');
    }
  }

  // Dockerfile과 마찬가지로 사용자가 이미 커스터마이즈했을 수 있는 workflow 파일을
  // 재실행 시 조용히 덮어쓰지 않는다 — --force를 명시해야만 갱신한다.
  if (hasWorkflow && !opts.force) {
    log(`${WORKFLOW_REL_PATH} 파일이 이미 존재합니다 — 건드리지 않고 넘어갑니다. 덮어쓰려면 --force 옵션을 사용하세요.`);
  } else {
    const workflow = renderTemplate(loadTpl('workflow.yml.tpl'), {
      BRANCH: opts.branch,
      PROJECT: projectName,
      IMAGE_REPO: imageRepo,
    });
    fs.mkdir(join(opts.cwd, '.github', 'workflows'));
    fs.writeFile(workflowPath, workflow);
  }

  const ghRepo = `${owner}/${repo}`;
  // gh 호출과 Cloudflare/deployer 요청은 수 초씩 걸려 아무 출력이 없으면 멈춘 것처럼 보인다.
  const urlResult = await withSpinner(
    `GitHub 시크릿 등록 중 (${ghRepo})`,
    () =>
      run('gh', ['secret', 'set', 'HOSTER_DEPLOY_URL', '--repo', ghRepo], {
        cwd: opts.cwd,
        input: config.deployerUrl,
      }),
    deps.progressIo
  );
  if (urlResult.code !== 0) {
    throw new Error(`gh secret set HOSTER_DEPLOY_URL 실패: ${urlResult.stderr || urlResult.stdout}`);
  }
  const secretResult = await run('gh', ['secret', 'set', 'HOSTER_DEPLOY_SECRET', '--repo', ghRepo], {
    cwd: opts.cwd,
    input: config.hmacSecret,
  });
  if (secretResult.code !== 0) {
    throw new Error(`gh secret set HOSTER_DEPLOY_SECRET 실패: ${secretResult.stderr || secretResult.stdout}`);
  }

  const cf = (deps.makeCloudflare ?? ((o) => new Cloudflare(o)))({
    apiToken: config.cloudflare.apiToken,
    accountId: config.cloudflare.accountId,
    zoneId: config.cloudflare.zoneId,
  });
  const client = (deps.makeClient ?? ((o) => new DeployerClient(o)))({
    baseUrl: config.deployerUrl,
    secret: config.hmacSecret,
  });

  const dnsName = `${projectName}.${config.baseDomain}`;
  // DNS 생성과 프로젝트 등록 사이에는 원자성이 없다 — 하나만 성공하고 다른 하나가
  // 실패하면 사용자에게 정확히 어디까지 완료됐는지, 어떻게 되돌리거나 재시도할지
  // 안내해야 한다(시크릿 값은 절대 포함하지 않는다).
  let dnsCreated = false;
  try {
    await withSpinner(
      `DNS 설정 중 (${dnsName})`,
      () => cf.upsertDnsCname(dnsName, `${config.cloudflare.tunnelId}.cfargotunnel.com`),
      deps.progressIo
    );
    dnsCreated = true;
    await withSpinner(
      `deployer에 프로젝트 등록 중 (${projectName})`,
      () => client.registerProject({ name: projectName, imageRepo, branch: opts.branch }),
      deps.progressIo
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log('');
    if (dnsCreated) {
      log(`중단됨 — DNS 레코드(${dnsName})는 이미 생성되었지만 프로젝트 등록에 실패했습니다: ${message}`);
      log('hoster add를 다시 실행하면 DNS는 upsert이므로 안전하게 재시도됩니다. 계속 실패하면 Cloudflare 대시보드에서 해당 CNAME 레코드를 확인하세요.');
    } else {
      log(`중단됨 — DNS 레코드(${dnsName}) 생성에 실패해 프로젝트 등록은 시도하지 않았습니다: ${message}`);
      log('Dockerfile/workflow 파일 생성과 gh secret 설정은 이미 완료된 상태입니다. 문제 해결 후 hoster add를 다시 실행하세요.');
    }
    throw e;
  }

  log('커밋 후 push하면 배포됩니다: git add Dockerfile .github && git commit && git push');
}
