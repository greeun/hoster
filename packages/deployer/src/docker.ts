import Dockerode from 'dockerode';
import { setTimeout as sleep } from 'node:timers/promises';

export class DockerManager {
  private docker: Dockerode;
  private network: string;
  private ghcrPat?: string;

  constructor(opts: { docker?: Dockerode; network?: string; ghcrPat?: string } = {}) {
    this.docker = opts.docker ?? new Dockerode({ socketPath: '/var/run/docker.sock' });
    this.network = opts.network ?? 'hoster-net';
    this.ghcrPat = opts.ghcrPat;
  }

  async pull(image: string): Promise<void> {
    const authconfig = this.ghcrPat
      ? { username: 'x', password: this.ghcrPat, serveraddress: 'ghcr.io' }
      : undefined;
    await new Promise<void>((resolve, reject) => {
      this.docker.pull(image, { authconfig }, (err, stream) => {
        if (err) return reject(err);
        this.docker.modem.followProgress(stream as NodeJS.ReadableStream, (e) => (e ? reject(e) : resolve()));
      });
    });
  }

  async run(opts: { name: string; image: string; domain: string; containerPort: number; env: string[] }): Promise<void> {
    const container = await this.docker.createContainer({
      name: opts.name,
      Image: opts.image,
      Env: opts.env,
      Labels: {
        'traefik.enable': 'true',
        [`traefik.http.routers.${opts.name}.rule`]: `Host(\`${opts.domain}\`)`,
        [`traefik.http.services.${opts.name}.loadbalancer.server.port`]: String(opts.containerPort),
        'hoster.managed': 'true',
      },
      HostConfig: {
        NetworkMode: this.network,
        RestartPolicy: { Name: 'unless-stopped' },
      },
    });
    await container.start();
  }

  /** 컨테이너를 정지만 하고 제거하지 않는다 — 롤백을 위해 다시 살릴 수 있어야 할 때 사용. */
  async stop(name: string): Promise<void> {
    await this.docker.getContainer(name).stop().catch((e) => this.ignoreAlreadyInTargetState(e));
  }

  async start(name: string): Promise<void> {
    await this.docker.getContainer(name).start().catch((e) => this.ignoreAlreadyInTargetState(e));
  }

  async stopAndRemove(name: string): Promise<void> {
    const c = this.docker.getContainer(name);
    await c.stop().catch((e) => this.ignoreAlreadyInTargetState(e));
    await c.remove().catch((e) => this.ignoreAlreadyInTargetState(e));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.docker.getContainer(from).rename({ name: to });
  }

  async logs(name: string, tail = 200): Promise<string> {
    const buf = await this.docker.getContainer(name).logs({ stdout: true, stderr: true, tail });
    return this.demux(buf as unknown as Buffer);
  }

  async removeImage(image: string): Promise<void> {
    await this.docker.getImage(image).remove().catch((e) => this.ignoreAlreadyInTargetState(e));
  }

  async healthCheck(url: string, timeoutMs = 60_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
        if (res.status < 400) return true;
      } catch {
        // 재시도
      }
      await sleep(1000);
    }
    return false;
  }

  /**
   * dockerode의 stop/start/remove 호출은 이미 정지됐거나 이미 기동 중인(304), 또는 이미
   * 없는(404) 대상에도 에러를 던진다 — 둘 다 "목표 상태에 이미 도달함"을 의미하므로 무시한다.
   * 그 외 에러(권한 문제, 데몬 장애 등)는 그대로 전파한다.
   *
   * start의 304가 특히 중요하다: 롤백 경로는 stop 실패 후에도 start를 호출하는데, 그때 old
   * 컨테이너는 대개 아직 실행 중이다. 여기서 던지면 진짜 원인(데몬 오류)이 "already started"로
   * 가려진다.
   */
  private ignoreAlreadyInTargetState(e: unknown): void {
    const code = (e as { statusCode?: number }).statusCode;
    if (code !== 404 && code !== 304) throw e;
  }

  /**
   * `docker logs`는 TTY 없이 실행 중인 컨테이너의 stdout/stderr을 하나의 스트림으로
   * 멀티플렉싱해 반환한다 — 각 프레임은 8바이트 헤더(0번째 바이트: 스트림 종류, 4~7번째
   * 바이트: payload 길이, big-endian)로 시작한다. 헤더를 제거하지 않으면 로그 텍스트에
   * 제어 바이트가 섞여 나온다.
   */
  private demux(buf: Buffer): string {
    let out = '';
    let offset = 0;
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset + 4);
      const start = offset + 8;
      const end = start + size;
      if (end > buf.length) break; // 불완전한 프레임 — 안전하게 중단
      out += buf.toString('utf-8', start, end);
      offset = end;
    }
    return out;
  }
}
