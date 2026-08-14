import { describe, it, expect, beforeEach } from 'vitest';
import { StateStore } from '../src/store.js';

const proj = {
  name: 'demo', imageRepo: 'ghcr.io/u/demo', domain: 'demo.example.com',
  branch: 'main', healthPath: '/', containerPort: 3000,
};

describe('StateStore', () => {
  let store: StateStore;
  beforeEach(() => { store = new StateStore(':memory:'); });

  it('프로젝트 upsert/get/list', () => {
    store.upsertProject(proj);
    expect(store.getProject('demo')?.domain).toBe('demo.example.com');
    store.upsertProject({ ...proj, branch: 'develop' });
    expect(store.getProject('demo')?.branch).toBe('develop');
    expect(store.listProjects()).toHaveLength(1);
  });

  it('이미지 현재/직전 갱신', () => {
    store.upsertProject(proj);
    store.setImages('demo', 'img:2', 'img:1');
    const p = store.getProject('demo')!;
    expect(p.currentImage).toBe('img:2');
    expect(p.previousImage).toBe('img:1');
  });

  it('배포 이력 기록/상태 갱신/최신순 조회', () => {
    store.upsertProject(proj);
    const id1 = store.recordDeployment({ project: 'demo', image: 'img:1', sha: 'aaa' });
    const id2 = store.recordDeployment({ project: 'demo', image: 'img:2', sha: 'bbb' });
    store.updateDeploymentStatus(id1, 'success');
    store.updateDeploymentStatus(id2, 'failed', 'health check timeout');
    const list = store.listDeployments('demo');
    expect(list[0].id).toBe(id2);
    expect(list[0].status).toBe('failed');
    expect(list[0].error).toBe('health check timeout');
    expect(list[1].status).toBe('success');
  });

  it('프로젝트 삭제', () => {
    store.upsertProject(proj);
    store.removeProject('demo');
    expect(store.getProject('demo')).toBeUndefined();
  });
});
