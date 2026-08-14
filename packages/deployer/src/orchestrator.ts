import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { StateStore } from './store.js';
import type { DockerManager } from './docker.js';

interface DeployReq { project: string; image: string; sha: string }
interface DeployResult { status: 'success' | 'failed' | 'skipped'; error?: string }
interface RollbackResult { status: 'success' | 'failed'; error?: string }

type Job =
  | { kind: 'deploy'; req: DeployReq; resolve: (r: DeployResult) => void }
  | { kind: 'rollback'; resolve: (r: RollbackResult) => void };

export class Orchestrator {
  private store: StateStore;
  private docker: DockerManager;
  private envDir: string;
  /** 프로젝트별 실행 중 여부 (deploy/rollback 공용 mutual exclusion) */
  private running = new Set<string>();
  /**
   * 프로젝트별 대기 큐. deploy는 최신 1건만 유지하며 기존에 대기 중이던 deploy는
   * skipped 처리한다. rollback은 skip되지 않고 도착 순서대로 대기한다.
   */
  private queues = new Map<string, Job[]>();

  constructor(opts: { store: StateStore; docker: DockerManager; envDir: string }) {
    this.store = opts.store;
    this.docker = opts.docker;
    this.envDir = opts.envDir;
  }

  deploy(req: DeployReq): Promise<DeployResult> {
    return new Promise<DeployResult>((resolve) => {
      this.enqueue(req.project, { kind: 'deploy', req, resolve });
    });
  }

  rollback(project: string): Promise<RollbackResult> {
    return new Promise<RollbackResult>((resolve) => {
      this.enqueue(project, { kind: 'rollback', resolve });
    });
  }

  readEnv(project: string): string[] {
    const file = join(this.envDir, `${project}.env`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  }

  private enqueue(project: string, job: Job): void {
    if (!this.running.has(project)) {
      this.running.add(project);
      void this.runJob(project, job);
      return;
    }
    const queue = this.queues.get(project) ?? [];
    if (job.kind === 'deploy') {
      // 기존에 대기 중이던 deploy는 skipped 처리하고 최신 요청으로 교체한다.
      // 대기 중인 rollback은 건드리지 않는다(순서 유지, skip 대상 아님).
      const remaining: Job[] = [];
      for (const j of queue) {
        if (j.kind === 'deploy') {
          j.resolve({ status: 'skipped' });
        } else {
          remaining.push(j);
        }
      }
      remaining.push(job);
      this.queues.set(project, remaining);
    } else {
      queue.push(job);
      this.queues.set(project, queue);
    }
  }

  private drain(project: string): void {
    const queue = this.queues.get(project);
    if (!queue || queue.length === 0) {
      this.running.delete(project);
      return;
    }
    const next = queue.shift()!;
    void this.runJob(project, next);
  }

  /**
   * deploy/rollback 작업을 실행한다. execute()/doRollback()은 내부에서 항상
   * 결과를 resolve하도록 설계돼 있지만, 예상치 못한 예외로 락(running)이
   * 영구히 걸리는 일이 없도록 한 번 더 안전망으로 감싼다.
   */
  private async runJob(project: string, job: Job): Promise<void> {
    try {
      if (job.kind === 'deploy') {
        const r = await this.execute(job.req);
        job.resolve(r);
      } else {
        const r = await this.doRollback(project);
        job.resolve(r);
      }
    } catch (e) {
      job.resolve({ status: 'failed', error: (e as Error).message });
    } finally {
      this.drain(project);
    }
  }

  private async execute(req: DeployReq): Promise<DeployResult> {
    let id: number | undefined;
    try {
      id = this.store.recordDeployment(req);
      const p = this.store.getProject(req.project);
      if (!p) throw new Error('unknown project');
      await this.docker.pull(req.image);
      const swap = await this.swapContainer(req.project, req.image);
      if (!swap.success) {
        this.safeUpdateStatus(id, 'failed', swap.error);
        return { status: 'failed', error: swap.error };
      }
      const dropped = p.previousImage;
      this.store.setImages(req.project, req.image, p.currentImage);
      if (dropped && dropped !== req.image && dropped !== p.currentImage) {
        await this.docker.removeImage(dropped);
      }
      this.safeUpdateStatus(id, 'success');
      return { status: 'success' };
    } catch (e) {
      const msg = (e as Error).message;
      this.safeUpdateStatus(id, 'failed', msg);
      return { status: 'failed', error: msg };
    }
  }

  private async doRollback(project: string): Promise<RollbackResult> {
    let id: number | undefined;
    try {
      const p = this.store.getProject(project);
      if (!p) return { status: 'failed', error: 'unknown project' };
      if (!p.previousImage) return { status: 'failed', error: 'no previous image' };
      const target = p.previousImage;
      id = this.store.recordDeployment({ project, image: target, sha: 'rollback' });
      const ok = await this.swapContainer(project, target);
      if (!ok.success) {
        this.safeUpdateStatus(id, 'failed', ok.error);
        return { status: 'failed', error: ok.error };
      }
      this.store.setImages(project, target, p.currentImage);
      this.safeUpdateStatus(id, 'rolled_back');
      return { status: 'success' };
    } catch (e) {
      const msg = (e as Error).message;
      this.safeUpdateStatus(id, 'failed', msg);
      return { status: 'failed', error: msg };
    }
  }

  /** 배포 이력 상태 갱신 실패는 배포 결과 자체에 영향을 주지 않도록 무시한다(best-effort). */
  private safeUpdateStatus(id: number | undefined, status: 'success' | 'failed' | 'rolled_back', error?: string): void {
    if (id === undefined) return;
    try {
      this.store.updateDeploymentStatus(id, status, error);
    } catch {
      // 상태 기록 실패는 무시 — 배포 성공/실패 판정 자체는 이미 확정됨
    }
  }

  /** 기존 컨테이너를 -old로 rename하고 새 이미지 기동, 헬스체크. 실패 시 원복. */
  private async swapContainer(project: string, image: string): Promise<{ success: boolean; error?: string }> {
    const p = this.store.getProject(project);
    if (!p) return { success: false, error: 'unknown project' };
    const name = `hoster-${project}`;
    const oldName = `${name}-old`;
    await this.docker.stopAndRemove(oldName);
    let renamed = false;
    try {
      await this.docker.rename(name, oldName);
      renamed = true;
    } catch {
      renamed = false; // 기존 컨테이너 없음 (최초 배포)
    }
    try {
      if (renamed) {
        // rename은 Docker 라벨을 바꾸지 않으므로 old 컨테이너는 여전히 새 컨테이너와 동일한
        // Traefik 라우터/서비스 라벨을 갖는다 — 실행 중인 채로 두면 헬스체크가 끝날 때까지
        // (최대 60초) Traefik이 같은 라우터에 두 백엔드(old+new)를 동시에 등록해, 아직
        // 검증되지 않은 새 컨테이너로도 트래픽이 흐를 수 있다. Traefik의 docker 프로바이더는
        // 실행 중인 컨테이너만 반영하므로, 여기서 정지(제거는 아님)시켜 즉시 라우팅에서
        // 제외한다 — 롤백 시에는 다시 살릴 수 있어야 하므로 stopAndRemove가 아니라 stop.
        // 이 호출은 반드시 아래 catch로 보호되는 영역 안에 있어야 한다 — 밖에 있으면
        // (예: 데몬 일시 장애로) 404/304가 아닌 에러를 던졌을 때 rename(oldName, name)
        // 롤백이 전혀 실행되지 못하고 서비스가 -old 상태로 완전히 멈춘 채 남는다.
        await this.docker.stop(oldName);
      }
      await this.docker.run({
        name, image, domain: p.domain, containerPort: p.containerPort, env: this.readEnv(project),
      });
      const healthy = await this.docker.healthCheck(
        `http://${name}:${p.containerPort}${p.healthPath}`
      );
      if (!healthy) throw new Error('health check failed');
      if (renamed) await this.docker.stopAndRemove(oldName);
      return { success: true };
    } catch (e) {
      await this.docker.stopAndRemove(name);
      if (renamed) {
        // 위에서 stop()으로 정지시켜 뒀으므로, rename만으로는 서비스가 복구되지 않는다 —
        // 원래 이름으로 되돌린 뒤 다시 start()해야 실행 중인 상태로 롤백이 완료된다.
        await this.docker.rename(oldName, name);
        await this.docker.start(name);
      }
      return { success: false, error: (e as Error).message };
    }
  }
}
