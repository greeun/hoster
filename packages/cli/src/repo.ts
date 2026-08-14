// git/프로젝트 감지를 위한 순수 함수 모음 — I/O 없음. runAdd(commands/add.ts)의 오케스트레이션에서만 호출된다.

// GitHub의 실제 owner/repo 문자 집합(영숫자, 마침표, 밑줄, 하이픈)만 허용한다.
// 기존 [^/]+ 패턴은 슬래시만 아니면 따옴표/개행까지 통과시켰는데, 이 값은 그대로
// templates/workflow.yml.tpl에 YAML 문자열과 셸 이중따옴표 문자열로 삽입되므로,
// origin 리모트를 조작할 수 있는 공격자가 대상 저장소의 CI에 YAML/셸을 주입할 수 있었다.
const GITHUB_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export function parseGitHubRepo(remoteUrl: string): { owner: string; repo: string } {
  const m = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/);
  if (!m) throw new Error(`GitHub 원격이 아닙니다: ${remoteUrl}`);
  const [, owner, repo] = m;
  if (!GITHUB_SEGMENT_RE.test(owner) || !GITHUB_SEGMENT_RE.test(repo)) {
    throw new Error(`GitHub 원격 URL의 owner/repo에 허용되지 않는 문자가 포함되어 있습니다: ${remoteUrl}`);
  }
  return { owner, repo };
}

// 서버(packages/deployer/src/app.ts)의 PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/ 와
// 반드시 일치해야 한다 — 문자 치환만으로는 "첫 글자가 영숫자"/"63자 이하" 규칙을
// 보장할 수 없으므로(예: 전부 하이픈으로 치환되는 이름) 아래에서 명시적으로 강제한다.
const PROJECT_NAME_MAX = 63;

// packages/deployer/src/app.ts의 PROJECT_NAME_RE와 반드시 동일해야 한다. projectNameOf()의
// 출력은 이 규칙을 항상 만족하도록 구성되지만, `hoster add --project <이름>`으로 사용자가
// 직접 지정한 값은 projectNameOf()를 거치지 않고 그대로 workflow.yml.tpl(YAML + printf 안
// 셸 이중따옴표 문자열)에 삽입되므로 별도로 검증해야 한다.
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidProjectName(name: string): boolean {
  return PROJECT_NAME_RE.test(name);
}

// git-check-ref-format의 전체 규칙 대신, 이 브랜치명이 삽입되는 두 컨텍스트
// (workflow.yml.tpl의 YAML 큰따옴표 문자열, printf 안의 셸 이중따옴표 문자열) 모두에서
// 안전한 보수적 부분집합만 허용한다 — 따옴표/개행/셸 메타문자/백슬래시를 전부 배제한다.
const SAFE_BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function isValidBranchName(branch: string): boolean {
  if (!SAFE_BRANCH_RE.test(branch)) return false;
  if (branch.includes('..') || branch.includes('//')) return false;
  if (branch.endsWith('/') || branch.endsWith('.lock')) return false;
  return true;
}

export function projectNameOf(repo: string): string {
  let out = repo
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (out.length > PROJECT_NAME_MAX) {
    // 자른 지점이 하이픈 뒤일 수 있으므로 다시 한 번 끝의 하이픈을 제거한다.
    out = out.slice(0, PROJECT_NAME_MAX).replace(/-+$/g, '');
  }

  if (!out) {
    throw new Error(
      `저장소 이름("${repo}")에서 유효한 프로젝트명을 만들 수 없습니다. --project 옵션으로 직접 지정하세요.`
    );
  }
  return out;
}

// GHCR은 저장소 경로(owner/repo)가 전부 소문자여야 한다 — GitHub 저장소명 자체는
// 대소문자를 허용하므로(parseGitHubRepo는 원본 대소문자를 그대로 보존), 이미지 경로를
// 구성하는 시점에 별도로 소문자화한다.
export function imageRepoOf(owner: string, repo: string): string {
  return `ghcr.io/${owner}/${repo}`.toLowerCase();
}

export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  const out = tpl.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) return `{{${k}}}`;
    return vars[k];
  });
  const missing = [...out.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  if (missing.length) throw new Error(`템플릿 토큰 미지정: ${missing.join(', ')}`);
  return out;
}

export function detectNextJs(pkgJson: string): boolean {
  const pkg = JSON.parse(pkgJson) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Boolean(pkg.dependencies?.next ?? pkg.devDependencies?.next);
}
