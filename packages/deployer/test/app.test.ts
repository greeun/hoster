import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../src/app.js';
import { StateStore } from '../src/store.js';
import { signPayload } from '../src/hmac.js';

const SECRET = 's3cret';

function makeDeps() {
  const store = new StateStore(':memory:');
  const docker = { logs: vi.fn().mockResolvedValue('line1\n'), stopAndRemove: vi.fn().mockResolvedValue(undefined) };
  const orchestrator = {
    deploy: vi.fn().mockResolvedValue({ status: 'success' }),
    rollback: vi.fn().mockResolvedValue({ status: 'success' }),
  };
  const envDir = mkdtempSync(join(tmpdir(), 'hoster-env-'));
  const app = buildApp({
    store, docker: docker as never, orchestrator: orchestrator as never,
    secret: SECRET, envDir, baseDomain: 'example.com',
  });
  return { app, store, docker, orchestrator, envDir };
}

function signedInit(method: string, body = ''): RequestInit {
  const ts = Date.now();
  return {
    method,
    headers: {
      'content-type': 'application/json',
      'x-hoster-timestamp': String(ts),
      'x-hoster-signature': signPayload(body, ts, SECRET),
    },
    ...(body ? { body } : {}),
  };
}

describe('deployer API', () => {
  let d: ReturnType<typeof makeDeps>;
  beforeEach(() => { d = makeDeps(); });

  it('서명 없으면 401', async () => {
    const res = await d.app.request('/status', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('healthz는 서명 불필요', async () => {
    const res = await d.app.request('/healthz');
    expect(res.status).toBe(200);
  });

  it('POST /projects 기본값 적용', async () => {
    const body = JSON.stringify({ name: 'demo', imageRepo: 'ghcr.io/u/demo', branch: 'main' });
    const res = await d.app.request('/projects', signedInit('POST', body));
    expect(res.status).toBe(200);
    const p = d.store.getProject('demo')!;
    expect(p.domain).toBe('demo.example.com');
    expect(p.containerPort).toBe(3000);
    expect(p.healthPath).toBe('/');
  });

  it('POST /deploy → orchestrator 호출', async () => {
    const body = JSON.stringify({ project: 'demo', image: 'img:1', sha: 'aaa' });
    const res = await d.app.request('/deploy', signedInit('POST', body));
    expect(res.status).toBe(200);
    expect(d.orchestrator.deploy).toHaveBeenCalledWith({ project: 'demo', image: 'img:1', sha: 'aaa' });
  });

  it('deploy 실패 시 500', async () => {
    d.orchestrator.deploy.mockResolvedValue({ status: 'failed', error: 'boom' });
    const body = JSON.stringify({ project: 'demo', image: 'img:1', sha: 'aaa' });
    const res = await d.app.request('/deploy', signedInit('POST', body));
    expect(res.status).toBe(500);
  });

  it('PUT /env set/remove 반영', async () => {
    const body1 = JSON.stringify({ set: { FOO: 'bar', BAZ: 'q' } });
    await d.app.request('/env/demo', signedInit('PUT', body1));
    const body2 = JSON.stringify({ remove: ['BAZ'] });
    await d.app.request('/env/demo', signedInit('PUT', body2));
    const content = readFileSync(join(d.envDir, 'demo.env'), 'utf-8');
    expect(content).toContain('FOO=bar');
    expect(content).not.toContain('BAZ');
  });

  it('GET /logs/:project', async () => {
    const res = await d.app.request('/logs/demo?tail=50', signedInit('GET'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('line1\n');
    expect(d.docker.logs).toHaveBeenCalledWith('hoster-demo', 50);
  });

  it('DELETE /projects/:name → 컨테이너 제거 + 등록 삭제', async () => {
    d.store.upsertProject({ name: 'demo', imageRepo: 'r', domain: 'd', branch: 'main', healthPath: '/', containerPort: 3000 });
    const res = await d.app.request('/projects/demo', signedInit('DELETE'));
    expect(res.status).toBe(200);
    expect(d.docker.stopAndRemove).toHaveBeenCalledWith('hoster-demo');
    expect(d.store.getProject('demo')).toBeUndefined();
  });

  it('경로 순회 시도 시 400, envDir 밖에 파일을 쓰지 않음', async () => {
    const outside = join(d.envDir, '..', '..', 'x.env');
    if (existsSync(outside)) unlinkSync(outside); // 취약점 존재 시 이전 실행에서 남았을 파일 정리
    const body = JSON.stringify({ set: { FOO: 'bar' } });
    const res = await d.app.request('/env/..%2F..%2Fx', signedInit('PUT', body));
    expect(res.status).toBe(400);
    expect(existsSync(outside)).toBe(false);
  });

  it('환경변수 키/값 검증: 잘못된 키/개행 값은 400', async () => {
    const badKey = JSON.stringify({ set: { 'BAD KEY': 'x' } });
    expect((await d.app.request('/env/demo', signedInit('PUT', badKey))).status).toBe(400);

    const badValue = JSON.stringify({ set: { FOO: 'line1\nline2' } });
    expect((await d.app.request('/env/demo', signedInit('PUT', badValue))).status).toBe(400);
  });

  it('잘못된 JSON body → 400', async () => {
    const res = await d.app.request('/deploy', signedInit('POST', '{not valid json'));
    expect(res.status).toBe(400);
  });

  it('POST /projects 도메인에 특수문자 포함 시 400', async () => {
    const body = JSON.stringify({ name: 'demo2', imageRepo: 'r', branch: 'main', domain: 'x`)' });
    const res = await d.app.request('/projects', signedInit('POST', body));
    expect(res.status).toBe(400);
  });

  it('env 파일 권한은 0600', async () => {
    const body = JSON.stringify({ set: { FOO: 'bar' } });
    await d.app.request('/env/demo', signedInit('PUT', body));
    const mode = statSync(join(d.envDir, 'demo.env')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('tail이 숫자가 아니면 기본값 200 사용', async () => {
    const res = await d.app.request('/logs/demo?tail=abc', signedInit('GET'));
    expect(res.status).toBe(200);
    expect(d.docker.logs).toHaveBeenCalledWith('hoster-demo', 200);
  });

  it('기존 env 파일이 0644였어도 PUT 이후 0600으로 강제됨', async () => {
    const file = join(d.envDir, 'demo.env');
    writeFileSync(file, 'OLD=1\n', { mode: 0o644 });
    const body = JSON.stringify({ set: { FOO: 'bar' } });
    await d.app.request('/env/demo', signedInit('PUT', body));
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
