import { describe, it, expect, vi } from 'vitest';
import { DockerManager } from '../src/docker.js';

/** 실제 dockerode의 멀티플렉스 로그 프레임(8바이트 헤더 + payload)을 생성한다. */
function multiplexFrame(streamType: number, payload: string): Buffer {
  const data = Buffer.from(payload, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(data.length, 4);
  return Buffer.concat([header, data]);
}

function mockDockerode() {
  const container = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    logs: vi.fn().mockResolvedValue(Buffer.from('log-line')),
  };
  return {
    container,
    api: {
      pull: vi.fn((_img: string, _opts: unknown, cb: (e: Error | null, s?: unknown) => void) => {
        cb(null, { on: vi.fn(), pipe: vi.fn() });
      }),
      modem: { followProgress: vi.fn((_s: unknown, done: (e: Error | null) => void) => done(null)) },
      createContainer: vi.fn().mockResolvedValue(container),
      getContainer: vi.fn().mockReturnValue(container),
      getImage: vi.fn().mockReturnValue({ remove: vi.fn().mockResolvedValue(undefined) }),
    },
  };
}

describe('DockerManager', () => {
  it('run: Traefik label과 네트워크 지정하여 컨테이너 생성/시작', async () => {
    const m = mockDockerode();
    const dm = new DockerManager({ docker: m.api as never, network: 'hoster-net' });
    await dm.run({ name: 'hoster-demo', image: 'ghcr.io/u/demo:abc', domain: 'demo.example.com', containerPort: 3000, env: ['FOO=bar'] });
    const arg = (m.api.createContainer as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.name).toBe('hoster-demo');
    expect(arg.Labels['traefik.enable']).toBe('true');
    expect(arg.Labels['traefik.http.routers.hoster-demo.rule']).toBe('Host(`demo.example.com`)');
    expect(arg.Labels['traefik.http.services.hoster-demo.loadbalancer.server.port']).toBe('3000');
    expect(arg.Env).toEqual(['FOO=bar']);
    expect(arg.HostConfig.NetworkMode).toBe('hoster-net');
    expect(arg.HostConfig.RestartPolicy.Name).toBe('unless-stopped');
    expect(m.container.start).toHaveBeenCalled();
  });

  it('stopAndRemove: 404 무시', async () => {
    const m = mockDockerode();
    m.container.stop.mockRejectedValue({ statusCode: 404 });
    m.container.remove.mockRejectedValue({ statusCode: 404 });
    const dm = new DockerManager({ docker: m.api as never });
    await expect(dm.stopAndRemove('none')).resolves.toBeUndefined();
  });

  // CRITICAL 리뷰 지시: Docker는 이미 정지된 컨테이너를 stop()하면 404가 아니라 304를
  // 던진다 — 기존 구현은 이를 그대로 전파해 orchestrator의 롤백 rename 라인이 실행되지
  // 못하게 만들었다(재현: "stopAndRemove THREW: 304 - container already stopped").
  it('stopAndRemove: 304(이미 정지됨) 무시', async () => {
    const m = mockDockerode();
    m.container.stop.mockRejectedValue({ statusCode: 304 });
    const dm = new DockerManager({ docker: m.api as never });
    await expect(dm.stopAndRemove('already-stopped')).resolves.toBeUndefined();
    expect(m.container.remove).toHaveBeenCalled();
  });

  it('stop: 정지만 하고 제거하지 않으며, 404/304는 무시한다', async () => {
    const m = mockDockerode();
    const dm = new DockerManager({ docker: m.api as never });
    await dm.stop('hoster-demo');
    expect(m.container.stop).toHaveBeenCalled();
    expect(m.container.remove).not.toHaveBeenCalled();

    m.container.stop.mockRejectedValue({ statusCode: 304 });
    await expect(dm.stop('hoster-demo')).resolves.toBeUndefined();
  });

  it('stop: 404/304가 아닌 에러는 그대로 전파한다', async () => {
    const m = mockDockerode();
    m.container.stop.mockRejectedValue({ statusCode: 500, message: 'daemon error' });
    const dm = new DockerManager({ docker: m.api as never });
    await expect(dm.stop('hoster-demo')).rejects.toMatchObject({ statusCode: 500 });
  });

  it('start: 컨테이너를 시작한다', async () => {
    const m = mockDockerode();
    const dm = new DockerManager({ docker: m.api as never });
    await dm.start('hoster-demo');
    expect(m.container.start).toHaveBeenCalled();
  });

  // 롤백 경로는 stop 실패 뒤에도 start를 호출하는데, 그때 old 컨테이너는 대개 아직 실행
  // 중이라 Docker가 304를 돌려준다. 여기서 던지면 진짜 원인이 "already started"로 가려진다.
  it('start: 304(이미 기동됨)는 무시한다', async () => {
    const m = mockDockerode();
    m.container.start.mockRejectedValue({ statusCode: 304 });
    const dm = new DockerManager({ docker: m.api as never });
    await expect(dm.start('hoster-demo')).resolves.toBeUndefined();
  });

  it('start: 404/304가 아닌 에러는 그대로 전파한다', async () => {
    const m = mockDockerode();
    m.container.start.mockRejectedValue({ statusCode: 500, message: 'daemon error' });
    const dm = new DockerManager({ docker: m.api as never });
    await expect(dm.start('hoster-demo')).rejects.toMatchObject({ statusCode: 500 });
  });

  it('logs: 멀티플렉스 스트림의 8바이트 헤더를 제거하고 순수 텍스트만 반환한다', async () => {
    const m = mockDockerode();
    const buf = Buffer.concat([
      multiplexFrame(1, 'hello world\n'),
      multiplexFrame(2, 'boom\n'),
    ]);
    m.container.logs.mockResolvedValue(buf);
    const dm = new DockerManager({ docker: m.api as never });
    await expect(dm.logs('hoster-demo')).resolves.toBe('hello world\nboom\n');
  });

  it('healthCheck: 서버 응답하면 true', async () => {
    const dm = new DockerManager({ docker: mockDockerode().api as never });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    await expect(dm.healthCheck('http://x/', 3000)).resolves.toBe(true);
    fetchMock.mockRestore();
  });

  it('healthCheck: 계속 실패하면 timeout 후 false', async () => {
    const dm = new DockerManager({ docker: mockDockerode().api as never });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('conn refused'));
    await expect(dm.healthCheck('http://x/', 1500)).resolves.toBe(false);
    fetchMock.mockRestore();
  }, 10_000);
});
