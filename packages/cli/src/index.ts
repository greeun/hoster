#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, type HosterConfig } from './config.js';
import { Nas } from './nas.js';
import { Cloudflare } from './cloudflare.js';
import { DeployerClient } from './client.js';
import { runInit } from './commands/init.js';
import { runAdd } from './commands/add.js';
import { runLs, runStatus, runLogs, runRollback, runEnv, runRemove, runDoctor } from './commands/ops.js';

// commander의 async .action() 콜백은 리젝트되어도 자동으로 잡히지 않는다 — 감싸지 않으면
// 사용자에게 원본 스택 트레이스가 그대로 노출된다. 여기서 잡아 메시지만 stderr에 출력하고
// exitCode를 세팅한다(시크릿은 각 커맨드 함수의 에러 메시지에 절대 포함하지 않는다).
function wrapAction<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  };
}

function makeClient(config: HosterConfig): DeployerClient {
  return new DeployerClient({ baseUrl: config.deployerUrl, secret: config.hmacSecret });
}

function makeCf(config: HosterConfig): Cloudflare {
  return new Cloudflare({
    apiToken: config.cloudflare.apiToken,
    accountId: config.cloudflare.accountId,
    zoneId: config.cloudflare.zoneId,
  });
}

const program = new Command();
program.name('hoster').description('홈서버 배포 도구');

// 설정값은 옵션 → 환경변수 → 기존 ~/.hoster/config.json → 프롬프트 순으로 채운다.
// Cloudflare API 토큰과 GHCR PAT은 셸 히스토리와 `ps` 출력에 남지 않도록 옵션으로 받지
// 않는다 — 환경변수(HOSTER_CF_API_TOKEN/HOSTER_GHCR_PAT)나 숨김 프롬프트로만 입력받는다.
program
  .command('init')
  .description('hoster 스택을 NAS에 설치합니다')
  .option('--dry-run', '실행하지 않고 계획만 표시')
  .option('--stack-dir <dir>', 'stack 디렉터리 경로', 'stack/')
  .option('--reuse-tunnel <id>', '기존 Cloudflare 터널 ID 재사용 (지정하면 조회/선택 프롬프트를 건너뜀)')
  .option('--nas-host <host>', 'NAS 호스트 (환경변수 HOSTER_NAS_HOST)')
  .option('--nas-port <port>', 'NAS SSH 포트 (환경변수 HOSTER_NAS_PORT, 기본 22)')
  .option('--nas-user <user>', 'NAS 사용자 (환경변수 HOSTER_NAS_USER)')
  .option('--base-domain <domain>', '기본 도메인 (환경변수 HOSTER_BASE_DOMAIN)')
  .option('--cf-account-id <id>', 'Cloudflare Account ID (환경변수 HOSTER_CF_ACCOUNT_ID)')
  .option('--cf-zone-id <id>', 'Cloudflare Zone ID (환경변수 HOSTER_CF_ZONE_ID)')
  .option('--non-interactive', '프롬프트 없이 실행 (값이 없으면 에러). CI에서 사용')
  .option('--rotate-hmac', 'HMAC_SECRET을 새로 생성 (등록된 레포마다 hoster add 재실행 필요)')
  .action(
    wrapAction(
      async (opts: {
        dryRun?: boolean;
        stackDir: string;
        reuseTunnel?: string;
        nasHost?: string;
        nasPort?: string;
        nasUser?: string;
        baseDomain?: string;
        cfAccountId?: string;
        cfZoneId?: string;
        nonInteractive?: boolean;
        rotateHmac?: boolean;
      }) => {
        await runInit({
          dryRun: Boolean(opts.dryRun),
          stackDir: opts.stackDir,
          reuseTunnelId: opts.reuseTunnel,
          cli: {
            nasHost: opts.nasHost,
            nasPort: opts.nasPort,
            nasUser: opts.nasUser,
            baseDomain: opts.baseDomain,
            cfAccountId: opts.cfAccountId,
            cfZoneId: opts.cfZoneId,
            nonInteractive: Boolean(opts.nonInteractive),
            rotateHmac: Boolean(opts.rotateHmac),
          },
        });
      }
    )
  );

program
  .command('add')
  .description('현재 디렉터리의 레포를 hoster에 등록합니다')
  .option('--branch <branch>', '배포 대상 브랜치', 'main')
  .option('--project <name>', '프로젝트명 (기본: 레포 이름에서 추론)')
  .option('--dry-run', '실행하지 않고 계획만 표시')
  .option('--force', '기존 workflow 파일을 덮어씀')
  .action(
    wrapAction(async (opts: { branch: string; project?: string; dryRun?: boolean; force?: boolean }) => {
      await runAdd({
        branch: opts.branch,
        project: opts.project,
        cwd: process.cwd(),
        dryRun: Boolean(opts.dryRun),
        force: Boolean(opts.force),
      });
    })
  );

program
  .command('ls')
  .description('등록된 프로젝트 목록을 표시합니다')
  .action(
    wrapAction(async () => {
      const config = loadConfig();
      await runLs({ client: makeClient(config) });
    })
  );

program
  .command('status')
  .description('프로젝트 상태 및 최근 배포 이력을 표시합니다')
  .argument('<project>', '프로젝트명')
  .action(
    wrapAction(async (project: string) => {
      const config = loadConfig();
      await runStatus(project, { client: makeClient(config) });
    })
  );

program
  .command('logs')
  .description('컨테이너 로그를 표시합니다')
  .argument('<project>', '프로젝트명')
  .option('--tail <n>', '표시할 로그 줄 수', '200')
  .action(
    wrapAction(async (project: string, opts: { tail: string }) => {
      const config = loadConfig();
      await runLogs(project, Number(opts.tail), { client: makeClient(config) });
    })
  );

program
  .command('rollback')
  .description('이전 이미지로 롤백합니다')
  .argument('<project>', '프로젝트명')
  .action(
    wrapAction(async (project: string) => {
      const config = loadConfig();
      await runRollback(project, { client: makeClient(config) });
    })
  );

const envCmd = program.command('env').description('프로젝트 환경변수를 관리합니다');

envCmd
  .command('set')
  .description('환경변수를 설정합니다 (KEY=VALUE ...)')
  .argument('<pairs...>', 'KEY=VALUE 목록')
  .option('--project <name>', '프로젝트명 (기본: 현재 레포에서 추론)')
  .option('--redeploy', '변경 후 현재 이미지로 재배포')
  .action(
    wrapAction(async (pairs: string[], opts: { project?: string; redeploy?: boolean }) => {
      const config = loadConfig();
      await runEnv('set', pairs, opts, { client: makeClient(config) });
    })
  );

envCmd
  .command('rm')
  .description('환경변수를 제거합니다 (KEY ...)')
  .argument('<keys...>', '제거할 키 목록')
  .option('--project <name>', '프로젝트명 (기본: 현재 레포에서 추론)')
  .action(
    wrapAction(async (keys: string[], opts: { project?: string }) => {
      const config = loadConfig();
      await runEnv('rm', keys, opts, { client: makeClient(config) });
    })
  );

program
  .command('remove')
  .description('프로젝트를 제거합니다 (deployer 등록/컨테이너 + DNS 레코드)')
  .argument('<project>', '프로젝트명')
  .action(
    wrapAction(async (project: string) => {
      const config = loadConfig();
      await runRemove(project, { client: makeClient(config), cf: makeCf(config) });
    })
  );

program
  .command('doctor')
  .description('NAS 접속/docker 권한/네트워크 상태를 점검합니다 (변경 없음)')
  .action(
    wrapAction(async () => {
      const config = loadConfig();
      await runDoctor({ input: { baseDomain: config.baseDomain, nas: config.nas }, nas: new Nas(config.nas) });
    })
  );

void program.parseAsync(process.argv);
