import { describe, it, expect, vi } from 'vitest';
import { runInit, type NasLike, type LocalExecResult } from '../src/commands/init.js';

const input = { baseDomain: 'example.com', nas: { host: '192.168.1.100', port: 2222, user: 'admin' } };

function makeFakeNas(execImpl?: (cmd: string) => Promise<string>) {
  const calls: string[] = [];
  const transferCalls: Array<{ localDir: string; remoteParent: string }> = [];
  const nas: NasLike = {
    exec: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      return execImpl ? execImpl(cmd) : '';
    }),
    transferDir: vi.fn(async (localDir: string, remoteParent: string) => {
      transferCalls.push({ localDir, remoteParent });
    }),
  };
  return { nas, calls, transferCalls };
}

function okLocal(): Promise<LocalExecResult> {
  return Promise.resolve({ code: 0, stdout: '', stderr: '' });
}

function baseDeps() {
  const { nas, calls, transferCalls } = makeFakeNas();
  const savedConfigs: unknown[] = [];
  const logs: string[] = [];
  const warns: string[] = [];
  const cfCalls: Array<{ method: string; args: unknown[] }> = [];
  const cf = {
    createTunnel: vi.fn(async (...args: unknown[]) => {
      cfCalls.push({ method: 'createTunnel', args });
      return { id: 'tunnel-123', token: 'secret-tunnel-token' };
    }),
    setTunnelIngress: vi.fn(async (...args: unknown[]) => {
      cfCalls.push({ method: 'setTunnelIngress', args });
    }),
    upsertDnsCname: vi.fn(async (...args: unknown[]) => {
      cfCalls.push({ method: 'upsertDnsCname', args });
    }),
    getTunnelToken: vi.fn(async (...args: unknown[]) => {
      cfCalls.push({ method: 'getTunnelToken', args });
      return 'reused-token-value';
    }),
    findTunnelByName: vi.fn(async (...args: unknown[]) => {
      cfCalls.push({ method: 'findTunnelByName', args });
      return undefined as { id: string; name: string; connections: number } | undefined;
    }),
    deleteTunnel: vi.fn(async (...args: unknown[]) => {
      cfCalls.push({ method: 'deleteTunnel', args });
    }),
  };
  const deps = {
    input,
    nas,
    makeCloudflare: vi.fn(() => cf),
    runLocal: vi.fn(okLocal),
    ask: vi.fn(async (q: string) => (q.includes('Account') ? 'acc-id' : 'zone-id')),
    askHidden: vi.fn(async (q: string) => (q.includes('GHCR') ? 'ghcr-pat-value' : 'cf-api-token-value')),
    randomHex: vi.fn(() => 'hmac-secret-hex-value'),
    saveConfig: vi.fn((cfg: unknown) => savedConfigs.push(cfg)),
    log: vi.fn((m: string) => logs.push(m)),
    warn: vi.fn((m: string) => warns.push(m)),
    sleep: vi.fn(async () => {}),
    // 기본은 비대화형 — 프롬프트를 검증하는 테스트만 명시적으로 true로 바꾼다.
    isInteractive: (() => false) as () => boolean,
    // 진행 표시는 비-TTY 경로로 검증한다 — 제어 문자 없이 logs에 줄 단위로 남는다.
    progressIo: {
      write: () => {},
      log: (s: string) => logs.push(s),
      isTty: false,
      now: () => 0,
      startTicker: () => () => {},
    },
  };
  return { deps, nas, calls, transferCalls, savedConfigs, logs, warns, cfCalls, cf };
}

describe('runInit — dry-run', () => {
  it('아무것도 실행하지 않고 계획만 출력한다', async () => {
    const { deps, nas, calls } = baseDeps();
    await runInit({ dryRun: true, stackDir: '/tmp/stack', deps });

    expect(calls).toHaveLength(0);
    expect(deps.runLocal).not.toHaveBeenCalled();
    expect(deps.askHidden).not.toHaveBeenCalled();
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.makeCloudflare).not.toHaveBeenCalled();
    expect(deps.saveConfig).not.toHaveBeenCalled();
    expect(nas.transferDir).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });
});

describe('runInit — 전체 실행', () => {
  it('시크릿이 실제 값으로 치환되어 NAS에 전달되고, 로그에는 노출되지 않는다', async () => {
    const { deps, calls, logs, cfCalls } = baseDeps();
    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    const envWriteCall = calls.find((c) => c.includes('TUNNEL_TOKEN=%s'));
    expect(envWriteCall).toBeDefined();
    // 실제 시크릿 값이 (안전하게 quote된 채) 전달되어야 한다 — 플레이스홀더가 남아있으면 버그.
    expect(envWriteCall).not.toContain('${TUNNEL_TOKEN}');
    expect(envWriteCall).not.toContain('${HMAC_SECRET}');
    expect(envWriteCall).not.toContain('${GHCR_PAT}');
    expect(envWriteCall).toContain("'secret-tunnel-token'");
    expect(envWriteCall).toContain("'hmac-secret-hex-value'");
    expect(envWriteCall).toContain("'ghcr-pat-value'");
    expect(envWriteCall).toContain('chmod 600');

    // cf-api 체인: createTunnel의 결과(tunnelId)가 setTunnelIngress/upsertDnsCname에 실제로 전달됨.
    const ingress = cfCalls.find((c) => c.method === 'setTunnelIngress');
    expect(ingress?.args[0]).toBe('tunnel-123');
    const dns = cfCalls.find((c) => c.method === 'upsertDnsCname');
    expect(dns?.args[1]).toBe('tunnel-123.cfargotunnel.com');

    // CARRY-OVER: 시크릿 값은 어떤 로그 라인에도 노출되면 안 된다.
    const joinedLogs = logs.join('\n');
    expect(joinedLogs).not.toContain('secret-tunnel-token');
    expect(joinedLogs).not.toContain('hmac-secret-hex-value');
    expect(joinedLogs).not.toContain('ghcr-pat-value');
    expect(joinedLogs).not.toContain('cf-api-token-value');
  });

  it('nas-transfer: 상태 디렉터리 준비 후 전송하고 임시 디렉터리를 정리한다', async () => {
    const { deps, calls, transferCalls } = baseDeps();
    await runInit({ dryRun: false, stackDir: '/local/path/stack', deps });

    expect(
      calls.some((c) => c === 'mkdir -p /volume1/docker/hoster/state/env /volume1/docker/hoster-tmp')
    ).toBe(true);
    expect(transferCalls).toEqual([{ localDir: '/local/path/stack', remoteParent: '/volume1/docker/hoster-tmp' }]);
    expect(calls.some((c) => c.includes("cp -a /volume1/docker/hoster-tmp/'stack'/.") && c.includes('rm -rf'))).toBe(
      true
    );
  });

  it('nas-transfer: 전송 전에 임시 추출 디렉터리를 만든다', async () => {
    // tar -C <remoteParent> -xf - 는 remoteParent가 없으면
    // "Cannot open: No such file or directory"로 실패한다.
    const { deps, nas, calls } = baseDeps();
    const order: string[] = [];
    (nas.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('mkdir') && cmd.includes('/volume1/docker/hoster-tmp')) order.push('mkdir-tmp');
      return '';
    });
    (nas.transferDir as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('transfer');
    });

    await runInit({ dryRun: false, stackDir: '/local/path/stack', deps });

    expect(order).toEqual(['mkdir-tmp', 'transfer']);
  });

  it('write-config: deployerUrl과 수집한 값들을 저장한다', async () => {
    const { deps, savedConfigs } = baseDeps();
    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(savedConfigs).toHaveLength(1);
    expect(savedConfigs[0]).toMatchObject({
      baseDomain: 'example.com',
      deployerUrl: 'https://hoster.example.com',
      hmacSecret: 'hmac-secret-hex-value',
      ghcrPat: 'ghcr-pat-value',
      cloudflare: { apiToken: 'cf-api-token-value', accountId: 'acc-id', zoneId: 'zone-id', tunnelId: 'tunnel-123' },
    });
  });

  it('hoster-net이 이미 존재하면(exec 에러에 exists 포함) 무시하고 계속 진행한다', async () => {
    const { deps, savedConfigs } = baseDeps();
    (deps.nas.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('network create hoster-net')) {
        throw new Error('ssh 실패 (1): Error response from daemon: network with name hoster-net already exists');
      }
      return '';
    });

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).resolves.toBeUndefined();
    // 이후 단계(write-config)까지 정상적으로 도달했는지 확인 — 에러가 삼켜졌다는 증거.
    expect(savedConfigs).toHaveLength(1);
  });

  it('네트워크 생성이 다른 이유로 실패하면(예: permission denied) 그대로 전파한다', async () => {
    const { deps } = baseDeps();
    (deps.nas.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('network create hoster-net')) {
        throw new Error('ssh 실패 (1): permission denied');
      }
      return '';
    });

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).rejects.toThrow(/permission denied/);
  });

  it('외부 통신 진단 실패 시 경고만 출력하고 중단하지 않는다', async () => {
    const { deps, warns, savedConfigs } = baseDeps();
    (deps.nas.exec as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('one.one.one.one')) {
        throw new Error('ssh 실패 (1): timeout');
      }
      return '';
    });

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).resolves.toBeUndefined();
    expect(warns.some((w) => w.includes('DSM 방화벽'))).toBe(true);
    expect(savedConfigs).toHaveLength(1);
  });

  it('healthz curl은 실패 시 10초 간격으로 재시도하고, 성공하면 멈춘다', async () => {
    const { deps } = baseDeps();
    let attempt = 0;
    (deps.runLocal as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('healthz')) {
        attempt++;
        return attempt < 3 ? { code: 1, stdout: '', stderr: 'connection refused' } : { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(attempt).toBe(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
    expect(deps.sleep).toHaveBeenCalledWith(10_000);
  });

  it('healthz curl이 6회 모두 실패하면 에러를 던진다', async () => {
    const { deps } = baseDeps();
    (deps.runLocal as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('healthz')) return { code: 1, stdout: '', stderr: 'connection refused' };
      return { code: 0, stdout: '', stderr: '' };
    });

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).rejects.toThrow(/healthz/);
    expect(deps.sleep).toHaveBeenCalledTimes(5);
  });
});

describe('runInit — 터널 이름 충돌 (fix round 1)', () => {
  it('createTunnel이 "이미 존재" 스타일 에러를 반환하면 안내 메시지 + 원본 오류를 함께 던진다', async () => {
    const { deps } = baseDeps();
    const cf = {
      createTunnel: vi.fn(async () => {
        throw new Error('Cloudflare API 실패: tunnel with name already exists');
      }),
      setTunnelIngress: vi.fn(),
      upsertDnsCname: vi.fn(),
      getTunnelToken: vi.fn(),
    };
    deps.makeCloudflare = vi.fn(() => cf);

    let caught: Error | undefined;
    try {
      await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain('hoster');
    expect(caught!.message).toMatch(/삭제/);
    expect(caught!.message).toMatch(/reuse-tunnel/);
    // fix round 2: 오탐이어도 진단 정보를 잃지 않도록 원본 Cloudflare 오류를 함께 보존한다.
    expect(caught!.message).toContain('tunnel with name already exists');
  });

  it('createTunnel이 다른 이유(예: 인증 실패)로 실패하면 원본 에러를 그대로 전파한다', async () => {
    const { deps } = baseDeps();
    const cf = {
      createTunnel: vi.fn(async () => {
        throw new Error('Cloudflare API 실패: invalid api token');
      }),
      setTunnelIngress: vi.fn(),
      upsertDnsCname: vi.fn(),
      getTunnelToken: vi.fn(),
    };
    deps.makeCloudflare = vi.fn(() => cf);

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).rejects.toThrow(/invalid api token/);
  });

  // fix round 2: 요금제 제한/일시 장애 메시지에 흔히 등장하는 "not available"/"in use"는
  // 이름 충돌과 무관하므로 더 이상 매치하지 않아야 한다 (오탐 방지 회귀 테스트).
  it('요금제 제한 등 이름 충돌과 무관한 실패는 안내로 대체하지 않고 원본을 그대로 전파한다', async () => {
    const { deps } = baseDeps();
    const cf = {
      createTunnel: vi.fn(async () => {
        throw new Error('Cloudflare API 실패: Tunnels not available on your plan');
      }),
      setTunnelIngress: vi.fn(),
      upsertDnsCname: vi.fn(),
      getTunnelToken: vi.fn(),
    };
    deps.makeCloudflare = vi.fn(() => cf);

    let caught: Error | undefined;
    try {
      await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toBe('Cloudflare API 실패: Tunnels not available on your plan');
    expect(caught!.message).not.toMatch(/reuse-tunnel/);
  });

  it('reuseTunnelId가 주어지면 createTunnel을 건너뛰고 기존 터널의 토큰을 재사용한다', async () => {
    const { deps, cf, cfCalls } = baseDeps();

    await runInit({ dryRun: false, stackDir: '/tmp/stack', reuseTunnelId: 'existing-tunnel-id', deps });

    expect(cf.createTunnel).not.toHaveBeenCalled();
    expect(cf.getTunnelToken).toHaveBeenCalledWith('existing-tunnel-id');

    const ingress = cfCalls.find((c) => c.method === 'setTunnelIngress');
    expect(ingress?.args[0]).toBe('existing-tunnel-id');
    const dns = cfCalls.find((c) => c.method === 'upsertDnsCname');
    expect(dns?.args[1]).toBe('existing-tunnel-id.cfargotunnel.com');
  });
});

describe('runInit — 진행 표시', () => {
  it('모든 단계에 [n/전체] 시작/완료 줄을 남긴다 (무출력 구간 제거)', async () => {
    const { deps, logs } = baseDeps();

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    const joined = logs.join('\n');
    // 12단계 계획의 첫 단계와 마지막 단계가 모두 표시되어야 한다.
    expect(joined).toContain('[1/12]');
    expect(joined).toContain('[12/12]');
    // 오래 걸리는 이미지 전송 단계가 진행 중임을 알 수 있어야 한다.
    expect(joined).toMatch(/\[8\/12\].*이미지/);
    // 완료 표시와 경과 시간이 함께 남아야 한다.
    expect(joined).toMatch(/✓ \[8\/12\].*초/);
  });

  it('healthz 재시도 중에는 시도 횟수를 노출한다', async () => {
    const { deps, logs } = baseDeps();
    let calls = 0;
    deps.runLocal = vi.fn(async (cmd: string) => {
      if (cmd.includes('healthz')) {
        calls++;
        // 3번째 시도에서 성공 — 그 전까지 재시도 표시가 보여야 한다.
        return calls >= 3 ? { code: 0, stdout: '', stderr: '' } : { code: 7, stdout: '', stderr: 'not yet' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(logs.join('\n')).toMatch(/재시도 2\/6/);
  });

  it('단계 실패 시 실패 표시를 남긴다', async () => {
    const { deps, logs } = baseDeps();
    deps.runLocal = vi.fn(async () => ({ code: 1, stdout: '', stderr: 'boom' }));

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).rejects.toThrow();

    expect(logs.join('\n')).toMatch(/✗ \[1\/12\]/);
  });

  it('dry-run에서는 진행 표시를 쓰지 않는다', async () => {
    const { deps, logs } = baseDeps();

    await runInit({ dryRun: true, stackDir: '/tmp/stack', deps });

    expect(logs.join('\n')).not.toMatch(/✓ \[/);
  });
});

describe('runInit — 기존 터널 대화형 처리 (대시보드 방문 불필요)', () => {
  // 프롬프트 응답을 순서대로 돌려주는 ask 목. 터널 관련 질문에만 응답을 소비하고,
  // Account/Zone ID 같은 기존 질문은 baseDeps와 동일하게 답한다.
  function scriptedAsk(answers: string[]) {
    const asked: string[] = [];
    const ask = vi.fn(async (q: string) => {
      if (q.includes('Account')) return 'acc-id';
      if (q.includes('Zone')) return 'zone-id';
      if (q.includes('기본 도메인')) return 'example.com';
      asked.push(q);
      return answers.shift() ?? '';
    });
    return { ask, asked };
  }

  function withExistingTunnel(connections = 0) {
    const { deps, cf, cfCalls, calls, logs } = baseDeps();
    (cf.findTunnelByName as ReturnType<typeof vi.fn>).mockImplementation(async (...args: unknown[]) => {
      cfCalls.push({ method: 'findTunnelByName', args });
      return { id: 'existing-tid', name: 'hoster', connections };
    });
    // vitest 실행 환경은 TTY가 아니므로, 대화형 경로를 검증하려면 명시해야 한다.
    deps.isInteractive = () => true;
    return { deps, cf, cfCalls, calls, logs };
  }

  it('같은 이름의 터널이 없으면 조회만 하고 그대로 생성한다', async () => {
    const { deps, cf } = baseDeps();

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(cf.findTunnelByName).toHaveBeenCalledWith('hoster');
    expect(cf.createTunnel).toHaveBeenCalled();
    expect(cf.deleteTunnel).not.toHaveBeenCalled();
  });

  it('기존 터널이 있으면 선택을 묻고, 기본값(빈 입력)은 재사용이다', async () => {
    const { deps, cf, cfCalls, logs } = withExistingTunnel();
    const { ask, asked } = scriptedAsk(['']);
    deps.ask = ask;

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    // 선택지 안내는 로그로, 입력은 프롬프트로 받는다.
    expect(logs.join('\n')).toMatch(/재사용/);
    expect(logs.join('\n')).toMatch(/삭제 후 새로 생성/);
    expect(asked).toHaveLength(1);
    expect(cf.createTunnel).not.toHaveBeenCalled();
    expect(cf.deleteTunnel).not.toHaveBeenCalled();
    expect(cf.getTunnelToken).toHaveBeenCalledWith('existing-tid');
    // 재사용한 터널 ID가 이후 인그레스/DNS 단계까지 이어져야 한다.
    expect(cfCalls.find((c) => c.method === 'setTunnelIngress')?.args[0]).toBe('existing-tid');
    expect(cfCalls.find((c) => c.method === 'upsertDnsCname')?.args[1]).toBe('existing-tid.cfargotunnel.com');
  });

  it('1을 선택하면 재사용한다', async () => {
    const { deps, cf } = withExistingTunnel();
    deps.ask = scriptedAsk(['1']).ask;

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(cf.getTunnelToken).toHaveBeenCalledWith('existing-tid');
    expect(cf.createTunnel).not.toHaveBeenCalled();
  });

  it('2를 선택하면 기존 터널을 삭제하고 새로 생성한다 (커넥션 0)', async () => {
    const { deps, cf, cfCalls } = withExistingTunnel(0);
    deps.ask = scriptedAsk(['2']).ask;

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(cf.deleteTunnel).toHaveBeenCalledWith('existing-tid');
    expect(cf.createTunnel).toHaveBeenCalled();
    // 삭제가 생성보다 먼저 일어나야 한다.
    const order = cfCalls.map((c) => c.method);
    expect(order.indexOf('deleteTunnel')).toBeLessThan(order.indexOf('createTunnel'));
  });

  it('활성 커넥션이 있는 터널 삭제는 yes 확인을 한 번 더 요구한다', async () => {
    const { deps, cf } = withExistingTunnel(2);
    const { ask, asked } = scriptedAsk(['2', 'no']);
    deps.ask = ask;

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(asked.join('\n')).toMatch(/커넥션/);
    // 확인을 통과하지 못했으므로 삭제하지 않고 재사용으로 되돌아간다.
    expect(cf.deleteTunnel).not.toHaveBeenCalled();
    expect(cf.getTunnelToken).toHaveBeenCalledWith('existing-tid');
  });

  it('활성 커넥션이 있어도 yes를 입력하면 삭제한다', async () => {
    const { deps, cf } = withExistingTunnel(2);
    deps.ask = scriptedAsk(['2', 'yes']).ask;

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(cf.deleteTunnel).toHaveBeenCalledWith('existing-tid');
    expect(cf.createTunnel).toHaveBeenCalled();
  });

  it('3을 선택하면 NAS에 아무것도 쓰지 않고 중단한다', async () => {
    const { deps, cf, calls } = withExistingTunnel();
    const { transferCalls } = deps.nas as unknown as { transferCalls?: unknown[] };
    deps.ask = scriptedAsk(['3']).ask;

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).rejects.toThrow(/중단/);

    expect(cf.createTunnel).not.toHaveBeenCalled();
    expect(cf.deleteTunnel).not.toHaveBeenCalled();
    // 터널 단계 이전의 읽기 전용 사전점검은 실행되지만, 쓰기 작업은 하나도 일어나지 않아야 한다.
    expect(transferCalls ?? []).toEqual([]);
    expect(calls.some((c) => c.includes('mkdir') || c.includes('compose up') || c.includes('network create'))).toBe(
      false
    );
    // 실제로 실행된 것은 읽기 전용 사전점검뿐이다.
    expect(calls).toEqual(['sudo -n /usr/local/bin/docker compose version']);
  });

  it('잘못된 입력은 다시 묻고, 계속 잘못되면 중단한다', async () => {
    const { deps, cf } = withExistingTunnel();
    const { ask, asked } = scriptedAsk(['9', 'x', 'zzz']);
    deps.ask = ask;

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).rejects.toThrow(/중단/);

    expect(asked.length).toBe(3);
    expect(cf.createTunnel).not.toHaveBeenCalled();
  });

  it('비대화형 환경에서는 묻지 않고 재사용하며 그 사실을 알린다', async () => {
    const { deps, cf, logs } = withExistingTunnel();
    const { ask, asked } = scriptedAsk([]);
    deps.ask = ask;
    deps.isInteractive = () => false;

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(asked).toEqual([]);
    expect(cf.getTunnelToken).toHaveBeenCalledWith('existing-tid');
    expect(logs.join('\n')).toMatch(/재사용/);
  });

  it('터널 조회 자체가 실패하면 경고만 남기고 생성 경로로 계속한다', async () => {
    const { deps, cf, warns } = baseDeps();
    (cf.findTunnelByName as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('list forbidden'));

    await runInit({ dryRun: false, stackDir: '/tmp/stack', deps });

    expect(warns.join('\n')).toMatch(/조회/);
    expect(cf.createTunnel).toHaveBeenCalled();
  });

  it('--reuse-tunnel이 주어지면 조회도 프롬프트도 하지 않는다', async () => {
    const { deps, cf } = withExistingTunnel();
    const { ask, asked } = scriptedAsk([]);
    deps.ask = ask;

    await runInit({ dryRun: false, stackDir: '/tmp/stack', reuseTunnelId: 'flag-tid', deps });

    expect(cf.findTunnelByName).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
    expect(cf.getTunnelToken).toHaveBeenCalledWith('flag-tid');
  });
});

describe('runInit — 부분 실패 복구 안내 (fix round 1)', () => {
  it('healthz 단계에서 최종 실패하면 시크릿 없는 복구 안내를 출력한 뒤 에러를 던진다', async () => {
    const { deps, logs } = baseDeps();
    (deps.runLocal as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('healthz')) return { code: 1, stdout: '', stderr: 'connection refused' };
      return { code: 0, stdout: '', stderr: '' };
    });

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).rejects.toThrow(/healthz/);

    const joined = logs.join('\n');
    expect(joined).toMatch(/HOSTER_DEPLOY_SECRET/);
    expect(joined).toMatch(/stack 디렉터리/);
    // 시크릿 실제 값은 복구 안내에도 절대 포함되면 안 된다.
    expect(joined).not.toContain('secret-tunnel-token');
    expect(joined).not.toContain('hmac-secret-hex-value');
    expect(joined).not.toContain('ghcr-pat-value');
    expect(joined).not.toContain('cf-api-token-value');
  });

  // IMPORTANT (리뷰 지시): write-config를 healthz-check보다 앞으로 옮겼으므로, healthz가
  // 끝까지 실패해도 로컬 설정 파일은 이미 저장돼 있어야 하고, 복구 안내는 그 사실과
  // 다음에 뭘 하면 되는지를 알려줘야 한다 (시크릿 값 자체는 노출하지 않는다).
  it('healthz 단계에서 최종 실패해도 config 파일은 이미 저장돼 있고, 복구 안내가 이를 언급한다', async () => {
    const { deps, logs, savedConfigs } = baseDeps();
    (deps.runLocal as ReturnType<typeof vi.fn>).mockImplementation(async (cmd: string) => {
      if (cmd.includes('healthz')) return { code: 1, stdout: '', stderr: 'connection refused' };
      return { code: 0, stdout: '', stderr: '' };
    });

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).rejects.toThrow(/healthz/);

    expect(savedConfigs).toHaveLength(1);
    const joined = logs.join('\n');
    expect(joined).toContain('config.json');
    expect(joined).not.toContain('secret-tunnel-token');
    expect(joined).not.toContain('hmac-secret-hex-value');
    expect(joined).not.toContain('ghcr-pat-value');
    expect(joined).not.toContain('cf-api-token-value');
  });

  it('터널 생성 단계에서 실패하면(NAS에 아직 아무것도 안 씀) NAS 상태 복구 안내를 출력하지 않는다', async () => {
    const { deps, logs } = baseDeps();
    const cf = {
      createTunnel: vi.fn(async () => {
        throw new Error('Cloudflare API 실패: rate limited');
      }),
      setTunnelIngress: vi.fn(),
      upsertDnsCname: vi.fn(),
      getTunnelToken: vi.fn(),
    };
    deps.makeCloudflare = vi.fn(() => cf);

    await expect(runInit({ dryRun: false, stackDir: '/tmp/stack', deps })).rejects.toThrow(/rate limited/);

    const joined = logs.join('\n');
    expect(joined).not.toContain('stack 디렉터리가 이미 전송');
    expect(joined).not.toContain('.env 파일이 이미 작성');
  });
});
