# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 명령어

pnpm workspace 모노레포(Node 22). 린터/포매터 설정은 없다 — 주변 코드 스타일에 맞춘다.

```bash
pnpm install
pnpm build                      # -r: 두 패키지 tsc 빌드 (+ CLI는 templates/를 dist/templates로 복사)
pnpm test                       # -r: vitest run

pnpm --filter @hoster/cli test                              # 패키지 하나만
pnpm --filter @hoster/cli exec vitest run test/runInit.test.ts   # 파일 하나만
pnpm --filter @hoster/cli exec vitest run -t '터널'              # 이름으로 필터
```

CLI 실행은 빌드 산출물로 한다: `node packages/cli/dist/index.js <command>`.
상태를 바꾸지 않고 동작을 확인하려면 `hoster init --dry-run` / `hoster add --dry-run`.

자동 테스트는 단위 테스트(dockerode/Cloudflare/gh/ssh 전부 주입 대체)와 `--dry-run` 계획 검증까지만 다룬다.
실제 NAS·Cloudflare·GitHub 검증은 `docs/e2e-checklist.md`의 수동 절차다. 설계 배경과 인터페이스
정의는 `docs/deliverables/`의 개발 산출물 문서를 참고한다.

## 구조

두 개의 런타임이 하나의 레포에 있다. 코드를 고칠 때 어느 쪽에서 실행되는지 항상 구분한다.

- `packages/cli` (`@hoster/cli`) — 개발자 Mac에서 실행. ssh/`gh`/`docker buildx`/Cloudflare API를 조합해
  NAS를 부트스트랩하고(`init`), 레포를 등록하고(`add`), deployer에 서명된 요청을 보낸다(`ops`).
- `packages/deployer` (`@hoster/deployer`) — NAS 컨테이너에서 실행. Hono API + dockerode + better-sqlite3.
- `stack/` — NAS로 전송되는 `docker-compose.yml`(cloudflared/traefik/deployer 3개 컨테이너).
- `templates/` — 등록 대상 레포에 써 넣는 GitHub Actions workflow와 Next.js Dockerfile.

배포 경로: push → Actions가 ghcr.io로 이미지 push → `POST https://hoster.<baseDomain>/deploy`(HMAC 서명)
→ Cloudflare Tunnel → deployer가 pull 후 컨테이너 교체 → Traefik 라벨로 라우팅.

두 시스템의 접점은 세 가지뿐이며, 한쪽만 바꾸면 조용히 깨진다:
1. **HMAC 계약** — `signPayload(body, ts, secret)` = HMAC-SHA256 of `` `${ts}.${body}` ``. 구현이
   `packages/cli/src/hmac.ts`, `packages/deployer/src/hmac.ts`, `templates/workflow.yml.tpl`의 openssl
   호출 **세 곳**에 존재한다. GET/DELETE는 body를 빈 문자열로 서명한다. 허용 시계 오차 300초.
2. **프로젝트명 규칙** — `PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/` 가 `packages/cli/src/repo.ts`와
   `packages/deployer/src/app.ts`에 중복 정의되어 있고 반드시 동일해야 한다. 이 값은 컨테이너명
   (`hoster-<project>`), env 파일 경로, Traefik 라우터 이름, 기본 도메인 라벨에 그대로 들어간다.
3. **deployer HTTP 계약** — `packages/cli/src/client.ts`의 메서드와 `packages/deployer/src/app.ts`의 라우트.

## 반드시 지켜야 할 불변식

**init 계획은 순수 함수다.** `planInit(input)`(`packages/cli/src/commands/init.ts`)은 I/O 없이 12개
액션 배열을 만들고, `--dry-run` 출력과 실제 실행이 같은 배열을 쓴다. 단계를 추가/변경하려면 이 함수를
고친다. 두 가지 제약:
- 액션의 `id`(`ssh-docker-precheck`/`compose-check`/`network-create`/`network-diagnostic`/`env-write`/
  `healthz-check`)는 실행 분기와 `runDoctor`(`commands/ops.ts`)가 액션을 다시 찾는 안정적인 키다.
  doctor는 설명 문자열이 아니라 이 id로 조회하므로 id를 지우거나 바꾸면 doctor가 조용히 점검을 건너뛴다.
- `write-config`는 반드시 `network-diagnostic`/`healthz-check`보다 **앞**에 있어야 한다. 이 시점이면
  터널·DNS·`.env`(HMAC_SECRET 포함)가 이미 NAS에 있어서, 설정을 저장하지 않으면 재시도할 때 시크릿과
  터널 ID를 되찾을 방법이 없다.

**시크릿은 계획 문자열에 담지 않는다.** 계획의 command에는 `${TUNNEL_TOKEN}` 같은 플레이스홀더만 남기고,
실행 시점에 `substitutePlaceholders`가 치환한다. 그래서 dry-run 출력과 에러 메시지에 시크릿이 새지 않는다.

**셸에 보간되는 모든 값은 `shQuote`를 거친다** (`packages/cli/src/shell.ts`). NAS host/user/port도 예외가
아니다. `substitutePlaceholders`가 `String.replaceAll` 대신 split/join을 쓰는 이유는 시크릿에 포함된 `$&`,
`$$`가 특수 치환 패턴으로 해석되는 것을 막기 위해서다.

**템플릿에 들어가는 값은 파일을 쓰기 전에 검증한다.** `--branch`/`--project`/origin의 owner·repo는
`workflow.yml.tpl` 안에 YAML 문자열과 `printf`의 셸 이중따옴표 문자열 **양쪽**으로 삽입된다.
`isValidBranchName`/`isValidProjectName`/`parseGitHubRepo`(`packages/cli/src/repo.ts`)의 보수적인 허용
집합을 넓히려면 이 두 컨텍스트 모두에서 안전한지 먼저 확인한다.

**컨테이너 스왑 순서**(`packages/deployer/src/orchestrator.ts`의 `swapContainer`)를 바꾸지 않는다.
`rename`은 Docker 라벨을 바꾸지 않으므로 `-old` 컨테이너는 새 컨테이너와 같은 Traefik 라우터를 그대로
갖는다. 그래서 rename 직후 `stop`(제거 아님)으로 라우팅에서 즉시 빼고, 이 `stop` 호출은 반드시 롤백을
담당하는 try/catch 안에 있어야 한다. 실패 시 `rename` + `start` 둘 다 해야 복구가 끝난다.
짧은 완전 중단은 검증되지 않은 버전으로의 트래픽 유출을 막기 위한 의도된 트레이드오프다 — 버그로 보고
"무중단"으로 고치지 않는다.

**deployer 이미지는 NAS에서 빌드하지 않는다.** NAS의 docker bridge 네트워크가 외부 통신에 실패한 이력이
있어, 로컬에서 `linux/amd64`로 빌드해 `docker save | ssh docker load`로 전송한다. `stack/docker-compose.yml`에
`build:` 섹션이 없는 것은 의도된 것이다.

**`/healthz`는 인증 미들웨어보다 먼저 등록**되어 서명 없이 응답한다(`packages/deployer/src/app.ts`).
라우트 등록 순서에 의존하는 의도된 예외이므로 미들웨어를 위로 옮기지 않는다.

## 코드 규칙

- **의존성 주입으로 테스트한다.** 각 커맨드(`runInit`/`runAdd`/`runEnv`/`runDoctor`)는 `deps` 객체로
  ssh 러너·`gh` 러너·Cloudflare 클라이언트·fs·프롬프트·시계·진행 표시 io를 받고 기본값을 자체 제공한다.
  테스트는 모듈 모킹 대신 이 deps에 페이크를 넣는다. 새 외부 호출을 추가하면 같은 방식으로 주입 가능하게 만든다.
- **오래 걸리는 단계에는 진행 표시를 붙인다** (`packages/cli/src/progress.ts`). `ProgressReporter`는
  단계 번호가 있는 흐름용, `withSpinner`는 deployer 응답 대기처럼 단일 대기 구간용이다. TTY에서는 한 줄을
  갱신하고 파이프에서는 제어 문자 없이 줄 단위로 출력한다 — 새 출력도 이 구분을 지킨다.
- **원자적이지 않은 지점은 사용자에게 어디까지 됐는지 알린다.** `add`(DNS ↔ 프로젝트 등록),
  `remove`(deployer 등록 ↔ DNS), `init`(`printRecoveryNote`)이 그렇게 되어 있다. 안내 문구에 시크릿 값은 넣지 않는다.
- 사용자 대상 문자열·에러 메시지·주석은 한국어다.
- 소스의 `IMPORTANT (리뷰 지시)`, `FIX (리뷰 지시, round N)`, `CARRY-OVER` 주석은 과거 리뷰에서 확정된
  결정을 기록한 것이다. 해당 코드를 고칠 때 함께 갱신하되, 근거 없이 지우지 않는다.
- deployer의 dockerode 호출은 404/304(이미 목표 상태)만 무시하고 나머지 에러는 전파한다
  (`ignoreAlreadyInTargetState`). 이 필터를 넓히면 데몬 장애가 성공으로 둔갑한다.
- deployer는 실패한 deploy/rollback에 HTTP 500을 반환하고 `DeployerClient.request()`가 throw하므로,
  CLI에서 `result.status === 'failed'` 분기는 도달하지 않는다. 실패 문구는 `friendlyDeployerErrorMessage`가
  응답 JSON의 `error` 필드를 뽑아 보여준다.

## NAS 쪽 고정 경로

`/volume1/docker/hoster`(스택 + `.env` 0600), `/volume1/docker/hoster/state`(sqlite + `env/<project>.env`),
`/volume1/docker/hoster-tmp`(tar 전송 임시), 네트워크 `hoster-net`(external), 로컬 설정
`~/.hoster/config.json`(0600). NAS docker는 `sudo -n /usr/local/bin/docker`로만 호출한다.
