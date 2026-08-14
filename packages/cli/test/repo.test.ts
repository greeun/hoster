import { describe, it, expect } from 'vitest';
import {
  parseGitHubRepo,
  projectNameOf,
  renderTemplate,
  detectNextJs,
  imageRepoOf,
  isValidBranchName,
  isValidProjectName,
} from '../src/repo.js';

describe('repo helpers', () => {
  it('ssh/https 원격 URL 파싱', () => {
    expect(parseGitHubRepo('git@github.com:foo/Bar.git')).toEqual({ owner: 'foo', repo: 'Bar' });
    expect(parseGitHubRepo('https://github.com/foo/bar')).toEqual({ owner: 'foo', repo: 'bar' });
  });

  it('GitHub 아니면 에러', () => {
    expect(() => parseGitHubRepo('git@gitlab.com:a/b.git')).toThrow();
  });

  // MUST-FIX/IMPORTANT 리뷰 지시: 기존 [^/]+ 패턴은 슬래시만 아니면 따옴표/개행도 통과시켰다
  // — owner/repo는 templates/workflow.yml.tpl에 YAML/셸 문자열로 그대로 삽입되므로, origin
  // 리모트를 조작할 수 있으면 대상 저장소의 CI에 YAML/셸을 주입할 수 있었다.
  it('owner/repo에 GitHub 문자 집합(영숫자/마침표/밑줄/하이픈) 밖의 문자가 있으면 에러', () => {
    expect(() => parseGitHubRepo('git@github.com:fo"o/bar.git')).toThrow();
    expect(() => parseGitHubRepo('git@github.com:foo/bar\nBAD: true.git')).toThrow();
    expect(() => parseGitHubRepo("git@github.com:foo/bar');touch pwn;('.git")).toThrow();
  });

  it('프로젝트명 정규화', () => {
    expect(projectNameOf('My_App.Next')).toBe('my-app-next');
  });

  it('템플릿 치환 및 누락 검증', () => {
    expect(renderTemplate('x {{A}} y', { A: '1' })).toBe('x 1 y');
    expect(() => renderTemplate('x {{A}} {{B}}', { A: '1' })).toThrow(/B/);
  });

  it('Next.js 감지', () => {
    expect(detectNextJs(JSON.stringify({ dependencies: { next: '15.0.0' } }))).toBe(true);
    expect(detectNextJs(JSON.stringify({ dependencies: { express: '4' } }))).toBe(false);
  });
});

// PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/ (packages/deployer/src/app.ts) — projectNameOf가
// 문자 치환뿐 아니라 "첫 글자 규칙"과 "63자 상한"까지 보장하는지 검증한다.
const SERVER_PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

describe('projectNameOf — 서버 검증 규칙 준수 (첫 글자/길이 상한)', () => {
  it('정규화 후 앞쪽에 하이픈만 남는 이름도 첫 글자가 영숫자가 되도록 다듬는다', () => {
    const name = projectNameOf('---My-Repo');
    expect(name).toBe('my-repo');
    expect(SERVER_PROJECT_NAME_RE.test(name)).toBe(true);
  });

  it('숫자로만 이루어진 저장소명도 유효한 프로젝트명이 된다', () => {
    const name = projectNameOf('12345');
    expect(name).toBe('12345');
    expect(SERVER_PROJECT_NAME_RE.test(name)).toBe(true);
  });

  it('63자를 초과하는 이름은 63자로 잘라내고, 잘린 끝에 하이픈이 남지 않는다', () => {
    const longRepo = 'a'.repeat(70);
    const name = projectNameOf(longRepo);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(SERVER_PROJECT_NAME_RE.test(name)).toBe(true);
  });

  it('하이픈 경계에서 63자로 잘렸을 때도 끝에 하이픈이 남지 않는다', () => {
    // 62번째 문자가 '-'가 되도록 구성 (자르면 "...-" 형태가 될 수 있는 경계 케이스)
    const longRepo = 'a'.repeat(61) + '-' + 'b'.repeat(20);
    const name = projectNameOf(longRepo);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.endsWith('-')).toBe(false);
    expect(SERVER_PROJECT_NAME_RE.test(name)).toBe(true);
  });

  it('영숫자가 전혀 남지 않는 저장소명은 에러를 던진다 (--project 직접 지정 필요)', () => {
    expect(() => projectNameOf('___')).toThrow(/--project/);
  });
});

describe('imageRepoOf — GHCR 소문자 규칙', () => {
  it('owner/repo 대소문자가 섞여 있어도 소문자 이미지 저장소 경로를 만든다', () => {
    expect(imageRepoOf('Foo', 'Bar-App')).toBe('ghcr.io/foo/bar-app');
  });

  it('이미 소문자인 경우도 그대로 동작한다', () => {
    expect(imageRepoOf('foo', 'bar')).toBe('ghcr.io/foo/bar');
  });
});

// MUST-FIX/IMPORTANT 리뷰 지시: --branch/--project는 사용자가 직접 지정할 수 있고
// projectNameOf()를 거치지 않을 수 있어(--project) workflow.yml.tpl에 검증 없이 삽입되면
// YAML/셸 주입으로 이어진다.
describe('isValidBranchName — 안전한 부분집합만 허용', () => {
  it('일반적인 브랜치명은 허용', () => {
    expect(isValidBranchName('main')).toBe(true);
    expect(isValidBranchName('release/1.2.3')).toBe(true);
    expect(isValidBranchName('feature/my_branch-1')).toBe(true);
  });

  it('따옴표/개행/셸 메타문자가 포함된 브랜치명은 거부', () => {
    expect(isValidBranchName('main"; rm -rf /; echo "')).toBe(false);
    expect(isValidBranchName('main\nBAD: true')).toBe(false);
    expect(isValidBranchName('main$(touch pwn)')).toBe(false);
    expect(isValidBranchName('main`touch pwn`')).toBe(false);
  });

  it('git ref 규칙상 위험한 형태(연속 마침표, 끝 슬래시, .lock)는 거부', () => {
    expect(isValidBranchName('a..b')).toBe(false);
    expect(isValidBranchName('feature/')).toBe(false);
    expect(isValidBranchName('main.lock')).toBe(false);
    expect(isValidBranchName('-leading-dash')).toBe(false);
  });
});

describe('isValidProjectName — 서버 PROJECT_NAME_RE와 동일한 규칙', () => {
  it('유효한 프로젝트명은 허용', () => {
    expect(isValidProjectName('my-app')).toBe(true);
    expect(isValidProjectName('a')).toBe(true);
  });

  it('--project로 직접 지정한 위험한 값은 거부', () => {
    expect(isValidProjectName('My-App')).toBe(false); // 대문자 불가
    expect(isValidProjectName('-leading-hyphen')).toBe(false);
    expect(isValidProjectName('proj"; rm -rf /; echo "')).toBe(false);
    expect(isValidProjectName('a'.repeat(64))).toBe(false); // 63자 초과
  });
});
