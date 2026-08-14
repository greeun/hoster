import { describe, it, expect, vi } from 'vitest';
import {
  parseEnvArgs,
  formatLs,
  runLs,
  runStatus,
  runLogs,
  runRollback,
  runEnv,
  runRemove,
  runDoctor,
  inferProjectName,
  type Runner,
} from '../src/commands/ops.js';

describe('ops helpers', () => {
  it('KEY=VAL 파싱, 값에 = 허용', () => {
    expect(parseEnvArgs(['A=1', 'B=x=y'])).toEqual({ A: '1', B: 'x=y' });
  });

  it('형식 위반 시 에러', () => {
    expect(() => parseEnvArgs(['NOVALUE'])).toThrow(/KEY=VAL/);
  });

  it('formatLs: 이미지 없으면 - 표시', () => {
    const out = formatLs([{ name: 'demo', domain: 'demo.example.com', currentImage: null }]);
    expect(out).toContain('demo');
    expect(out).toContain('-');
  });
});

describe('runLs', () => {
  it('SHA 앞 7자만 표시', async () => {
    const logs: string[] = [];
    const client = { status: vi.fn(async () => [{ name: 'demo', domain: 'demo.example.com', currentImage: 'ghcr.io/x/demo:abcdef1234567890' }]) };
    await runLs({ client, log: (m) => logs.push(m) });
    const out = logs.join('\n');
    expect(out).toContain('abcdef1');
    expect(out).not.toContain('abcdef1234567890');
  });

  it('빈 목록이면 안내 메시지', async () => {
    const logs: string[] = [];
    const client = { status: vi.fn(async () => []) };
    await runLs({ client, log: (m) => logs.push(m) });
    expect(logs.join('\n')).toContain('등록된 프로젝트가 없습니다');
  });
});

describe('runStatus', () => {
  it('프로젝트 정보와 배포 이력을 출력', async () => {
    const logs: string[] = [];
    const client = {
      statusOf: vi.fn(async () => ({
        name: 'demo',
        domain: 'demo.example.com',
        currentImage: 'ghcr.io/x/demo:sha1',
        previousImage: null,
        deployments: [{ id: 1, image: 'ghcr.io/x/demo:sha1', sha: 'sha1', status: 'success', error: null, createdAt: '2026-01-01' }],
      })),
    };
    await runStatus('demo', { client, log: (m) => logs.push(m) });
    const out = logs.join('\n');
    expect(out).toContain('demo.example.com');
    expect(out).toContain('success');
  });
});

describe('runLogs', () => {
  it('tail 값을 그대로 전달하고 결과를 출력', async () => {
    const logs: string[] = [];
    const client = { logs: vi.fn(async () => 'line1\nline2') };
    await runLogs('demo', 50, { client, log: (m) => logs.push(m) });
    expect(client.logs).toHaveBeenCalledWith('demo', 50);
    expect(logs.join('\n')).toContain('line1');
  });
});

// 진행 표시를 비-TTY 경로로 받아 제어 문자 없이 줄 단위로 검증한다.
function testProgressIo(sink: string[]) {
  return {
    write: () => {},
    log: (s: string) => sink.push(s),
    isTty: false,
    now: () => 0,
    startTicker: () => () => {},
  };
}

describe('runRollback', () => {
  it('성공 시 안내 메시지', async () => {
    const logs: string[] = [];
    const client = { rollback: vi.fn(async () => ({ status: 'success' })) };
    await runRollback('demo', { client, log: (m) => logs.push(m), progressIo: testProgressIo(logs) });
    expect(logs.join('\n')).toContain('롤백');
  });

  it('deployer 응답을 기다리는 동안 대기 표시를 남긴다', async () => {
    const progress: string[] = [];
    const client = { rollback: vi.fn(async () => ({ status: 'success' })) };

    await runRollback('demo', { client, log: () => {}, progressIo: testProgressIo(progress) });

    // 헬스체크 대기 중임을 알 수 있어야 하고, 완료 표시로 끝나야 한다.
    expect(progress.join('\n')).toMatch(/헬스체크/);
    expect(progress[progress.length - 1]).toContain('✓');
  });

  it('실패 시에도 대기 표시를 실패로 마감한다', async () => {
    const progress: string[] = [];
    const client = {
      rollback: vi.fn(async () => {
        throw new Error('deployer 응답 500: {"error":"no previous image"}');
      }),
    };

    await expect(
      runRollback('demo', { client, log: () => {}, progressIo: testProgressIo(progress) })
    ).rejects.toThrow(/롤백 실패/);

    expect(progress.join('\n')).toContain('✗');
  });

  // FIX (리뷰 지시, round 2): 실제 DeployerClient.request()는 실패한 rollback에서 값을
  // 반환하는 게 아니라 `deployer 응답 500: {...}` 형태로 throw한다(deployer가 실패 결과에
  // HTTP 500을 반환하므로). 목이 client를 직접 흉내 내더라도 실제와 같은 모양(throw,
  // 그것도 client.ts가 실제로 만드는 문자열 형식)으로 재현해야 한다 — resolve하는
  // { status: 'failed' } 목은 실제로는 도달하지 않는 분기만 검증하는 거짓 안심 테스트다.
  it('실패 시(HTTP 500) client가 throw한 원본 에러에서 error 필드를 추출해 친절한 메시지로 throw', async () => {
    const client = {
      rollback: vi.fn(async () => {
        throw new Error('deployer 응답 500: {"status":"failed","error":"no previous image"}');
      }),
    };
    await expect(runRollback('demo', { client })).rejects.toThrow(/^롤백 실패: no previous image$/);
  });

  it('실패 응답 본문이 JSON이 아니거나 error 필드가 없으면 원본 메시지를 그대로 포함', async () => {
    const client = {
      rollback: vi.fn(async () => {
        throw new Error('deployer 응답 500: <html>Internal Server Error</html>');
      }),
    };
    await expect(runRollback('demo', { client })).rejects.toThrow(
      /롤백 실패: deployer 응답 500: <html>Internal Server Error<\/html>/
    );
  });
});

describe('inferProjectName', () => {
  it('git remote에서 프로젝트명을 추론', async () => {
    const run: Runner = vi.fn(async () => ({ code: 0, stdout: 'git@github.com:Foo/Bar-App.git\n', stderr: '' }));
    await expect(inferProjectName(run, '/repo')).resolves.toBe('bar-app');
  });

  it('git remote 조회 실패 시 에러', async () => {
    const run: Runner = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'not a git repo' }));
    await expect(inferProjectName(run, '/repo')).rejects.toThrow(/--project/);
  });
});

describe('runEnv', () => {
  it('set: --project 미지정 시 git remote로 추론해 env를 갱신', async () => {
    const logs: string[] = [];
    const client = { env: vi.fn(async () => ({ ok: true })), statusOf: vi.fn(), deploy: vi.fn() };
    const run: Runner = vi.fn(async () => ({ code: 0, stdout: 'git@github.com:Foo/Bar-App.git\n', stderr: '' }));
    await runEnv('set', ['A=1'], {}, { client, run, cwd: '/repo', log: (m) => logs.push(m) });
    expect(client.env).toHaveBeenCalledWith('bar-app', { set: { A: '1' } });
    expect(logs.join('\n')).toContain('bar-app');
  });

  it('rm: 키 목록을 그대로 remove로 전달', async () => {
    const client = { env: vi.fn(async () => ({ ok: true })), statusOf: vi.fn(), deploy: vi.fn() };
    await runEnv('rm', ['A', 'B'], { project: 'demo' }, { client });
    expect(client.env).toHaveBeenCalledWith('demo', { remove: ['A', 'B'] });
  });

  it('--redeploy: 현재 이미지로 deploy를 재요청 (success)', async () => {
    const logs: string[] = [];
    const client = {
      env: vi.fn(async () => ({ ok: true })),
      statusOf: vi.fn(async () => ({ currentImage: 'ghcr.io/x/demo:sha123' })),
      deploy: vi.fn(async () => ({ status: 'success' })),
    };
    await runEnv('set', ['A=1'], { project: 'demo', redeploy: true }, { client, log: (m) => logs.push(m) });
    expect(client.deploy).toHaveBeenCalledWith({ project: 'demo', image: 'ghcr.io/x/demo:sha123', sha: 'sha123' });
    expect(logs.join('\n')).toContain('success');
  });

  // deploy는 대기 중이던 이전 deploy 요청을 최신 요청으로 교체하면서 skipped를 반환할 수
  // 있다(packages/deployer/src/orchestrator.ts) — HTTP 200으로 정상 반환되는 값이므로
  // throw가 아니라 이 값 그대로 사용자에게 안내해야 한다.
  it('--redeploy: deploy가 skipped를 반환하면 그대로 안내', async () => {
    const logs: string[] = [];
    const client = {
      env: vi.fn(async () => ({ ok: true })),
      statusOf: vi.fn(async () => ({ currentImage: 'ghcr.io/x/demo:sha123' })),
      deploy: vi.fn(async () => ({ status: 'skipped' })),
    };
    await runEnv('set', ['A=1'], { project: 'demo', redeploy: true }, { client, log: (m) => logs.push(m) });
    expect(logs.join('\n')).toContain('skipped');
  });

  it('--redeploy인데 배포된 이미지가 없으면 에러', async () => {
    const client = {
      env: vi.fn(async () => ({ ok: true })),
      statusOf: vi.fn(async () => ({ currentImage: null })),
      deploy: vi.fn(),
    };
    await expect(runEnv('set', ['A=1'], { project: 'demo', redeploy: true }, { client })).rejects.toThrow(/재배포/);
    expect(client.deploy).not.toHaveBeenCalled();
  });

  // FIX (리뷰 지시, round 2): runRollback과 동일한 이유로 deploy 실패는 resolve된 값이 아니라
  // client.ts가 실제로 만드는 형식(`deployer 응답 500: {...}`)의 throw로 재현해야 한다.
  it('--redeploy: deploy가 실패(HTTP 500)하면 client가 throw한 에러에서 error 필드를 추출', async () => {
    const client = {
      env: vi.fn(async () => ({ ok: true })),
      statusOf: vi.fn(async () => ({ currentImage: 'ghcr.io/x/demo:sha123' })),
      deploy: vi.fn(async () => {
        throw new Error('deployer 응답 500: {"status":"failed","error":"health check failed"}');
      }),
    };
    await expect(
      runEnv('set', ['A=1'], { project: 'demo', redeploy: true }, { client })
    ).rejects.toThrow(/^재배포 실패: health check failed$/);
  });
});

describe('runRemove', () => {
  it('deployer 등록 제거 후 statusOf가 반환한 domain으로 DNS 삭제, workflow 안내 메시지 포함', async () => {
    const logs: string[] = [];
    const client = {
      statusOf: vi.fn(async () => ({ name: 'demo', domain: 'demo.example.com' })),
      removeProject: vi.fn(async () => ({ ok: true })),
    };
    const cf = { deleteDnsRecord: vi.fn(async () => {}) };
    await runRemove('demo', { client, cf, log: (m) => logs.push(m) });
    expect(client.statusOf).toHaveBeenCalledWith('demo');
    expect(cf.deleteDnsRecord).toHaveBeenCalledWith('demo.example.com');
    expect(logs.join('\n')).toContain('workflow');
  });

  // FIX (리뷰 지시, round 1): domain은 `${project}.${baseDomain}` 관례로 재구성하지 않고
  // statusOf()가 반환한 실제 저장된 값을 그대로 사용해야 한다 — 커스텀 domain으로 등록된
  // 프로젝트는 관례와 다를 수 있고, 재구성된 값을 쓰면 엉뚱한 DNS 레코드를 지우고 진짜
  // 레코드는 남기게 된다.
  it('statusOf가 관례와 다른 domain을 반환하면 그 값을 그대로 사용', async () => {
    const client = {
      statusOf: vi.fn(async () => ({ name: 'demo', domain: 'custom.example.com' })),
      removeProject: vi.fn(async () => ({ ok: true })),
    };
    const cf = { deleteDnsRecord: vi.fn(async () => {}) };
    await runRemove('demo', { client, cf });
    expect(cf.deleteDnsRecord).toHaveBeenCalledWith('custom.example.com');
    expect(cf.deleteDnsRecord).not.toHaveBeenCalledWith('demo.example.com');
  });

  it('statusOf 실패(미등록 등) 시 명확한 에러를 던지고 removeProject/DNS 삭제는 시도하지 않음', async () => {
    const client = {
      statusOf: vi.fn(async () => {
        throw new Error('deployer 응답 404: {"error":"not found"}');
      }),
      removeProject: vi.fn(async () => ({ ok: true })),
    };
    const cf = { deleteDnsRecord: vi.fn(async () => {}) };
    await expect(runRemove('demo', { client, cf })).rejects.toThrow(/정보를 조회할 수 없어/);
    expect(client.removeProject).not.toHaveBeenCalled();
    expect(cf.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it('deployer 제거 실패 시 DNS는 건드리지 않고 에러', async () => {
    const client = {
      statusOf: vi.fn(async () => ({ name: 'demo', domain: 'demo.example.com' })),
      removeProject: vi.fn(async () => {
        throw new Error('boom');
      }),
    };
    const cf = { deleteDnsRecord: vi.fn(async () => {}) };
    await expect(runRemove('demo', { client, cf })).rejects.toThrow(/boom/);
    expect(cf.deleteDnsRecord).not.toHaveBeenCalled();
  });

  it('DNS 삭제 실패 시 deployer는 이미 제거됐다고 안내', async () => {
    const client = {
      statusOf: vi.fn(async () => ({ name: 'demo', domain: 'demo.example.com' })),
      removeProject: vi.fn(async () => ({ ok: true })),
    };
    const cf = {
      deleteDnsRecord: vi.fn(async () => {
        throw new Error('cf down');
      }),
    };
    await expect(runRemove('demo', { client, cf })).rejects.toThrow(/cf down/);
  });
});

describe('runDoctor', () => {
  const input = { baseDomain: 'example.com', nas: { host: '192.168.1.100', port: 2222, user: 'admin' } };

  it('사전 점검 + 네트워크 진단만 실행하고 상태를 바꾸지 않는다', async () => {
    const execCalls: string[] = [];
    const nas = { exec: vi.fn(async (cmd: string) => { execCalls.push(cmd); return ''; }) };
    const runLocal = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const logs: string[] = [];
    await runDoctor({ input, nas, runLocal, log: (m) => logs.push(m) });

    expect(runLocal).toHaveBeenCalledTimes(1);
    expect(execCalls).toHaveLength(2);
    expect(execCalls.some((c) => c.includes('compose version'))).toBe(true);
    expect(execCalls.some((c) => c.includes('hoster-net'))).toBe(true);
    expect(execCalls.some((c) => c.includes('network create'))).toBe(false);
    expect(logs.join('\n')).toContain('점검 완료');
  });

  it('네트워크 진단 실패는 throw 대신 경고만 출력', async () => {
    const nas = {
      exec: vi.fn(async (cmd: string) => {
        if (cmd.includes('wget')) throw new Error('unreachable');
        return '';
      }),
    };
    const runLocal = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const warns: string[] = [];
    await expect(runDoctor({ input, nas, runLocal, warn: (m) => warns.push(m) })).resolves.toBeUndefined();
    expect(warns.join('\n')).toContain('외부 통신 불가');
  });

  it('ssh/docker 사전 점검 실패는 throw', async () => {
    const nas = { exec: vi.fn(async () => '') };
    const runLocal = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'permission denied' }));
    await expect(runDoctor({ input, nas, runLocal })).rejects.toThrow(/permission denied/);
    expect(nas.exec).not.toHaveBeenCalled();
  });
});
