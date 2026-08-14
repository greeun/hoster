import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/store.js';
import { Orchestrator } from '../src/orchestrator.js';
import { DockerManager } from '../src/docker.js';

function mockDocker(healthOk = true): DockerManager {
  return {
    pull: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    stopAndRemove: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    logs: vi.fn().mockResolvedValue(''),
    removeImage: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(healthOk),
  } as unknown as DockerManager;
}

/**
 * 실제 DockerManager를 실제 dockerode 없이 검증하기 위한 최소 상태 기반 fake dockerode.
 * 컨테이너 이름별로 실행 상태(running)와 이미지를 추적해 rename/stop/start/remove가
 * 서로 어떻게 상호작용하는지(예: rename은 running 상태를 바꾸지 않음, 이미 정지된
 * 컨테이너의 stop()은 304를 던짐)까지 그대로 재현한다.
 */
function makeFakeDockerode() {
  interface FakeContainer { name: string; running: boolean; image: string }
  const containers = new Map<string, FakeContainer>();
  let crashNextStart = false;

  function handle(name: string) {
    return {
      start: vi.fn(async () => {
        const c = containers.get(name);
        if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        c.running = true;
        if (crashNextStart) {
          crashNextStart = false;
          c.running = false; // 시작 직후 앱이 죽는 상황을 흉내낸다
        }
      }),
      stop: vi.fn(async () => {
        const c = containers.get(name);
        if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        if (!c.running) throw Object.assign(new Error('container already stopped'), { statusCode: 304 });
        c.running = false;
      }),
      remove: vi.fn(async () => {
        if (!containers.has(name)) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        containers.delete(name);
      }),
      rename: vi.fn(async ({ name: to }: { name: string }) => {
        const c = containers.get(name);
        if (!c) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        containers.delete(name);
        c.name = to;
        containers.set(to, c);
      }),
      logs: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    };
  }

  const api = {
    createContainer: vi.fn(async (config: { name: string; Image: string }) => {
      containers.set(config.name, { name: config.name, running: false, image: config.Image });
      return handle(config.name);
    }),
    getContainer: vi.fn((name: string) => handle(name)),
    pull: vi.fn((_img: string, _opts: unknown, cb: (e: Error | null, s?: unknown) => void) => {
      cb(null, { on: vi.fn(), pipe: vi.fn() });
    }),
    modem: { followProgress: vi.fn((_s: unknown, done: (e: Error | null) => void) => done(null)) },
    getImage: vi.fn().mockReturnValue({ remove: vi.fn().mockResolvedValue(undefined) }),
  };

  return {
    api,
    containers,
    crashNextContainerRightAfterStart: () => { crashNextStart = true; },
  };
}

const proj = {
  name: 'demo', imageRepo: 'ghcr.io/u/demo', domain: 'demo.example.com',
  branch: 'main', healthPath: '/', containerPort: 3000,
};

describe('Orchestrator', () => {
  let store: StateStore;
  let envDir: string;

  beforeEach(() => {
    store = new StateStore(':memory:');
    store.upsertProject(proj);
    envDir = mkdtempSync(join(tmpdir(), 'hoster-env-'));
  });

  it('성공 배포: pull→rename→run→health→old 제거, 이미지 상태 갱신', async () => {
    const docker = mockDocker(true);
    const orch = new Orchestrator({ store, docker, envDir });
    const res = await orch.deploy({ project: 'demo', image: 'img:1', sha: 'aaa' });
    expect(res.status).toBe('success');
    expect(docker.pull).toHaveBeenCalledWith('img:1');
    expect(docker.run).toHaveBeenCalled();
    expect(store.getProject('demo')!.currentImage).toBe('img:1');
    expect(store.listDeployments('demo')[0].status).toBe('success');
  });

  it('헬스체크 실패: 새 컨테이너 제거 + old 복구(재시작) + failed 기록', async () => {
    const docker = mockDocker(false);
    const orch = new Orchestrator({ store, docker, envDir });
    store.setImages('demo', 'img:1', null);
    const res = await orch.deploy({ project: 'demo', image: 'img:2', sha: 'bbb' });
    expect(res.status).toBe('failed');
    expect(docker.stop).toHaveBeenCalledWith('hoster-demo-old');
    expect(docker.rename).toHaveBeenCalledWith('hoster-demo-old', 'hoster-demo');
    // IMPORTANT 리뷰 지시: rename만으로는 부족하다 — Traefik 등록에서 빼기 위해 stop() 해둔
    // old 컨테이너를 다시 start()해야 실제로 서비스가 복구된다.
    expect(docker.start).toHaveBeenCalledWith('hoster-demo');
    expect(store.getProject('demo')!.currentImage).toBe('img:1');
    expect(store.listDeployments('demo')[0].status).toBe('failed');
  });

  // 재리뷰 지시: Traefik 등록 해제용 stop(oldName) 호출이 롤백을 보호하는 try 블록 밖에
  // 있으면, stop()이 404/304가 아닌 에러(데몬 일시 장애 등)를 던졌을 때 rename(oldName,
  // name) 롤백이 전혀 실행되지 못하고 서비스가 -old 상태로 완전히 멈춘 채 남는다.
  it('old 컨테이너 stop()이 404/304 아닌 에러로 실패해도 롤백(rename+start)이 실행되고 failed 반환', async () => {
    const docker = mockDocker(true);
    (docker.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('docker daemon error'), { statusCode: 500 })
    );
    const orch = new Orchestrator({ store, docker, envDir });
    store.setImages('demo', 'img:1', null);
    const res = await orch.deploy({ project: 'demo', image: 'img:2', sha: 'x' });

    expect(res.status).toBe('failed');
    expect(res.error).toBe('docker daemon error'); // swapContainer 밖으로 예외가 새지 않음
    expect(docker.run).not.toHaveBeenCalled(); // stop 실패 시점에 새 컨테이너는 아직 기동 전
    expect(docker.rename).toHaveBeenCalledWith('hoster-demo-old', 'hoster-demo'); // 롤백 rename 실행됨
    expect(docker.start).toHaveBeenCalledWith('hoster-demo'); // 롤백 후 재시작됨
    expect(store.getProject('demo')!.currentImage).toBe('img:1'); // 배포 실패 — 이미지 상태 그대로
  });

  it('env 파일 파싱하여 run에 전달', async () => {
    writeFileSync(join(envDir, 'demo.env'), '# comment\nFOO=bar\n\nBAZ=qux=1\n');
    const docker = mockDocker(true);
    const orch = new Orchestrator({ store, docker, envDir });
    await orch.deploy({ project: 'demo', image: 'img:1', sha: 'aaa' });
    const runArg = (docker.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(runArg.env).toEqual(['FOO=bar', 'BAZ=qux=1']);
  });

  it('rollback: previousImage로 재배포 후 스왑', async () => {
    const docker = mockDocker(true);
    const orch = new Orchestrator({ store, docker, envDir });
    store.setImages('demo', 'img:2', 'img:1');
    const res = await orch.rollback('demo');
    expect(res.status).toBe('success');
    expect(store.getProject('demo')!.currentImage).toBe('img:1');
    expect(store.getProject('demo')!.previousImage).toBe('img:2');
  });

  it('rollback: previousImage 없으면 failed', async () => {
    const orch = new Orchestrator({ store, docker: mockDocker(true), envDir });
    const res = await orch.rollback('demo');
    expect(res.status).toBe('failed');
  });

  it('동시 deploy: 진행 중 1건 + 대기 최신 1건만, 중간 요청 skipped', async () => {
    const docker = mockDocker(true);
    let release!: () => void;
    (docker.pull as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => new Promise<void>((r) => { release = r; })
    );
    const orch = new Orchestrator({ store, docker, envDir });
    const p1 = orch.deploy({ project: 'demo', image: 'img:1', sha: 'a' });
    const p2 = orch.deploy({ project: 'demo', image: 'img:2', sha: 'b' });
    const p3 = orch.deploy({ project: 'demo', image: 'img:3', sha: 'c' });
    release();
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.status).toBe('success');
    expect(r2.status).toBe('skipped');
    expect(r3.status).toBe('success');
  });

  it('recordDeployment 실패 시 failed 반환, 락은 해제되어 다음 배포는 정상 진행', async () => {
    const docker = mockDocker(true);
    const orch = new Orchestrator({ store, docker, envDir });
    vi.spyOn(store, 'recordDeployment').mockImplementationOnce(() => {
      throw new Error('db down');
    });

    const res1 = await orch.deploy({ project: 'demo', image: 'img:1', sha: 'a' });
    expect(res1.status).toBe('failed');
    expect(res1.error).toBe('db down');

    const res2 = await orch.deploy({ project: 'demo', image: 'img:2', sha: 'b' });
    expect(res2.status).toBe('success');
    expect(store.getProject('demo')!.currentImage).toBe('img:2');
  });

  it('rollback이 진행 중인 deploy와 겹치지 않고 순서대로 직렬 실행됨', async () => {
    store.setImages('demo', 'img:1', null);
    const docker = mockDocker(true);
    const order: string[] = [];
    let releasePull!: () => void;
    (docker.pull as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      order.push('pull');
      return new Promise<void>((resolve) => { releasePull = resolve; });
    });
    (docker.stopAndRemove as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('stopAndRemove'); });
    (docker.stop as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('stop'); });
    (docker.rename as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('rename'); });
    (docker.run as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('run'); });
    (docker.healthCheck as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push('healthCheck'); return true; });

    const orch = new Orchestrator({ store, docker, envDir });
    const deployPromise = orch.deploy({ project: 'demo', image: 'img:2', sha: 'x' });
    expect(order).toEqual(['pull']);

    const rollbackPromise = orch.rollback('demo');
    // rollback은 진행 중인 deploy 뒤로 큐잉만 되어야 하며 아직 docker 호출이 발생하면 안 됨
    expect(order).toEqual(['pull']);

    releasePull();
    const [deployResult, rollbackResult] = await Promise.all([deployPromise, rollbackPromise]);

    expect(deployResult.status).toBe('success');
    expect(rollbackResult.status).toBe('success');
    expect(order).toEqual([
      'pull',
      'stopAndRemove', 'rename', 'stop', 'run', 'healthCheck', 'stopAndRemove',
      'stopAndRemove', 'rename', 'stop', 'run', 'healthCheck', 'stopAndRemove',
    ]);
  });

  it('rollback 중 stopAndRemove가 non-404 에러를 던지면 failed 반환 (unhandled rejection 없음)', async () => {
    const docker = mockDocker(true);
    (docker.stopAndRemove as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('docker daemon error'), { statusCode: 500 })
    );
    const orch = new Orchestrator({ store, docker, envDir });
    store.setImages('demo', 'img:2', 'img:1');
    const res = await orch.rollback('demo');
    expect(res.status).toBe('failed');
    expect(res.error).toBe('docker daemon error');
  });

  // CRITICAL 리뷰 지시 재현 시나리오: 실제 DockerManager(+ 상태를 추적하는 fake dockerode)를
  // 사용해, 새 컨테이너가 헬스체크 실패 시점에 이미 죽어 있어(=크래시) stop()이 304를
  // 던지는 상황에서도 stopAndRemove가 이를 삼키고, 그 뒤에 이어지는 rollback의
  // rename+start 라인이 실제로 실행되어 old 컨테이너가 "실행 중" 상태로 복구되는지
  // 실제 DockerManager 구현 코드 경로로 검증한다 (mock으로는 이 상호작용을 확인할 수 없다).
  it('[통합] 새 컨테이너가 크래시(이미 정지)해 stop()이 304를 던져도 롤백 rename이 실행되고 old가 실행 중으로 복구된다', async () => {
    const fake = makeFakeDockerode();
    const docker = new DockerManager({ docker: fake.api as never });
    const orch = new Orchestrator({ store, docker, envDir });

    // 1) 최초 배포: 정상적으로 성공시켜 'hoster-demo' 컨테이너가 img:1로 실행 중인 상태를 만든다.
    vi.spyOn(docker, 'healthCheck').mockResolvedValueOnce(true);
    const first = await orch.deploy({ project: 'demo', image: 'img:1', sha: 'a' });
    expect(first.status).toBe('success');
    expect(fake.containers.get('hoster-demo')).toMatchObject({ running: true, image: 'img:1' });

    // 2) 두 번째 배포: 새 컨테이너가 시작 직후 크래시하고(= stop() 시 304), 헬스체크도 실패한다.
    fake.crashNextContainerRightAfterStart();
    vi.spyOn(docker, 'healthCheck').mockResolvedValueOnce(false);
    const second = await orch.deploy({ project: 'demo', image: 'img:2', sha: 'b' });

    expect(second.status).toBe('failed');
    expect(second.error).toBe('health check failed'); // 304가 아니라 원래 실패 사유가 그대로 보고됨
    // 롤백이 끝까지 실행되어 원래(img:1) 컨테이너가 원래 이름으로, 실행 중인 상태로 복구됨.
    expect(fake.containers.get('hoster-demo')).toMatchObject({ running: true, image: 'img:1' });
    expect(fake.containers.has('hoster-demo-old')).toBe(false);
    expect(store.getProject('demo')!.currentImage).toBe('img:1');
  });
});
