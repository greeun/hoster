import { describe, it, expect } from 'vitest';
import { planInit } from '../src/commands/init.js';
import { shQuote } from '../src/shell.js';

describe('planInit', () => {
  const input = { baseDomain: 'example.com', nas: { host: '192.168.1.100', port: 2222, user: 'admin' } };

  it('필수 액션 순서 포함', () => {
    const plan = planInit(input);
    const kinds = plan.map((a) => a.kind);
    expect(kinds[0]).toBe('local-exec'); // ssh 사전 점검
    expect(kinds).toContain('nas-transfer');
    expect(kinds).toContain('cf-api');
    expect(kinds).toContain('write-config');
    expect(kinds.at(-1)).toBe('local-exec'); // healthz 확인이 마지막
  });

  // IMPORTANT (리뷰 지시): write-config가 healthz 확인보다 먼저 실행돼야 healthz가 실패해도
  // (전파 지연 등으로) 로컬에 시크릿/터널ID가 담긴 설정이 남는다 — 그렇지 않으면 사용자는
  // 재시도 시 시크릿을 알 방법이 없어 터널 이름 충돌에 부딪힌다.
  it('write-config가 healthz-check보다 먼저 실행된다', () => {
    const plan = planInit(input);
    const writeIdx = plan.findIndex((a) => a.kind === 'write-config');
    const healthzIdx = plan.findIndex((a) => a.id === 'healthz-check');
    expect(writeIdx).toBeGreaterThanOrEqual(0);
    expect(healthzIdx).toBeGreaterThan(writeIdx);
  });

  it('네트워크 생성이 compose up보다 먼저', () => {
    const plan = planInit(input);
    const netIdx = plan.findIndex((a) => a.command?.includes('network create hoster-net'));
    const upIdx = plan.findIndex((a) => a.command?.includes('compose --env-file .env up -d'));
    expect(netIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(netIdx);
  });

  it('docker는 항상 sudo 절대경로', () => {
    const plan = planInit(input);
    for (const a of plan.filter((x) => x.kind === 'nas-exec' && x.command?.includes('docker'))) {
      expect(a.command).toContain('sudo -n /usr/local/bin/docker');
    }
  });

  // 이미지 로드(local-exec) 이후에 compose up이 실행되어야 함 — 그렇지 않으면
  // docker-compose.yml이 참조하는 hoster-deployer:latest 이미지를 찾지 못해 up이 실패한다.
  it('이미지 빌드/전송이 compose up보다 먼저', () => {
    const plan = planInit(input);
    const buildIdx = plan.findIndex((a) => a.command?.includes('docker buildx build'));
    const upIdx = plan.findIndex((a) => a.command?.includes('compose --env-file .env up -d'));
    expect(buildIdx).toBeGreaterThanOrEqual(0);
    expect(upIdx).toBeGreaterThan(buildIdx);
  });

  it('stack 전송이 이미지 빌드보다 먼저', () => {
    const plan = planInit(input);
    const kinds = plan.map((a) => a.kind);
    const transferIdx = kinds.indexOf('nas-transfer');
    const buildIdx = plan.findIndex((a) => a.command?.includes('docker buildx build'));
    expect(transferIdx).toBeGreaterThanOrEqual(0);
    expect(buildIdx).toBeGreaterThan(transferIdx);
  });

  it('cf-api 액션이 createTunnel → setTunnelIngress → upsertDnsCname 순서로 존재', () => {
    const plan = planInit(input);
    const cfMethods = plan.filter((a) => a.kind === 'cf-api').map((a) => a.method);
    expect(cfMethods).toEqual(['createTunnel', 'setTunnelIngress', 'upsertDnsCname']);
  });

  it('setTunnelIngress 인그레스 규칙에 baseDomain이 반영된다', () => {
    const plan = planInit(input);
    const action = plan.find((a) => a.method === 'setTunnelIngress');
    const rules = action?.args?.[1] as { hostname: string; service: string }[];
    expect(rules).toEqual([
      { hostname: 'hoster.example.com', service: 'http://hoster-deployer:8080' },
      { hostname: '*.example.com', service: 'http://hoster-traefik:80' },
    ]);
  });

  // CARRY-OVER (팀 리드 지시): 시크릿(TUNNEL_TOKEN/HMAC_SECRET/GHCR_PAT)은 InitInput에
  // 애초에 존재하지 않으므로 planInit이 이를 알 수 없다 — 커맨드 문자열에는 반드시
  // ${...} 플레이스홀더만 남아야 하고, 치환은 runInit 실행 시점에만 일어나야 한다.
  it('시크릿은 플레이스홀더로만 존재하고 실제 값이 노출되지 않는다 (dry-run 안전성)', () => {
    const plan = planInit(input);
    const serialized = JSON.stringify(plan);
    expect(serialized).toContain('${TUNNEL_TOKEN}');
    expect(serialized).toContain('${HMAC_SECRET}');
    expect(serialized).toContain('${GHCR_PAT}');
    // HMAC_SECRET 실제 생성 형식(randomBytes(32).toString('hex') = 64자리 hex)이
    // 우연히도 섞여 있지 않은지 재확인
    expect(serialized).not.toMatch(/[a-f0-9]{64}/);
  });

  it('.env 파일 작성 커맨드는 mode 0600(chmod 600)을 포함한다', () => {
    const plan = planInit(input);
    const envAction = plan.find((a) => a.command?.includes('TUNNEL_TOKEN=%s'));
    expect(envAction?.command).toContain('chmod 600 /volume1/docker/hoster/.env');
  });

  it('NAS 정보(host/port/user)가 안전하게 인용되어 사전 점검 명령에 반영된다', () => {
    const plan = planInit(input);
    expect(plan[0].command).toContain(`-p ${shQuote('2222')}`);
    expect(plan[0].command).toContain(shQuote('admin@192.168.1.100'));
  });

  // CARRY-OVER (리뷰 지시): "보간되는 모든 값은 shQuote를 거친다"는 불변식에 예외가
  // 없어야 한다 — host/user에 셸 메타문자가 섞여도 init.ts가 실제로 shQuote를 적용하는지
  // (원본 값이 그대로 concat되지 않는지) 회귀 테스트로 고정한다.
  // FIX (리뷰 지시, round 2): doctor(ops.ts)가 사전 점검/compose 확인 액션을 설명 문자열
  // 매칭이나 "id 없는 유일한 nas-exec" 같은 취약한 방식으로 찾지 않고, 안정적인 id로
  // 재사용할 수 있어야 한다.
  it('doctor가 재사용할 사전 점검/compose 확인 액션에 안정적인 id가 있다', () => {
    const plan = planInit(input);
    const precheck = plan.find((a) => a.id === 'ssh-docker-precheck');
    const composeCheck = plan.find((a) => a.id === 'compose-check');
    expect(precheck?.kind).toBe('local-exec');
    expect(precheck?.description).toContain('사전 점검');
    expect(composeCheck?.kind).toBe('nas-exec');
    expect(composeCheck?.description).toContain('compose');
  });

  it('NAS host에 셸 메타문자가 있어도 shQuote를 거쳐 이스케이프된다', () => {
    const evilHost = `x'; touch /tmp/pwn; echo '`;
    const evilInput = { baseDomain: 'example.com', nas: { host: evilHost, port: 2222, user: 'admin' } };
    const plan = planInit(evilInput);
    expect(plan[0].command).toContain(shQuote(`admin@${evilHost}`));
    // 이스케이프되지 않은 원본 문자열(따옴표가 열린 채)이 그대로 노출되면 안 된다.
    expect(plan[0].command).not.toContain(`admin@${evilHost} `);
  });
});
