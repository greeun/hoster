# hoster

[English](README.md) | 한국어

Synology NAS(Container Manager)를 Vercel처럼 쓰는 셀프호스팅 배포 도구입니다.
GitHub 레포에 push하면 GitHub Actions가 Docker 이미지를 빌드해 ghcr.io에 push하고,
NAS에 상주하는 deployer가 이를 pull해 컨테이너로 교체 배포하며, Cloudflare Tunnel을
통해 `<프로젝트>.<도메인>` 공개 URL로 서비스합니다.

- 개발 산출물(요구사항·아키텍처·상세설계·API·DB·인터페이스·보안·테스트·운영·사용자 매뉴얼): [`docs/deliverables/`](docs/deliverables/)
- E2E 검증 체크리스트: [`docs/e2e-checklist.md`](docs/e2e-checklist.md)

## 레포 구성

```
hoster/
├── packages/
│   ├── cli/          # hoster CLI (commander, 로컬 Mac에서 실행)
│   └── deployer/     # 배포 API 서버 (Hono + dockerode + better-sqlite3, NAS에서 컨테이너로 실행)
├── stack/            # NAS에 전송되는 docker-compose.yml, .env.example
├── templates/        # GitHub Actions workflow, Next.js Dockerfile 템플릿
└── docs/             # 개발 산출물 문서, E2E 체크리스트
```

## 아키텍처

### NAS 상주 스택 (3개 컨테이너, `docker compose`)

| 컨테이너 | 이미지 | 역할 |
|---|---|---|
| `hoster-cloudflared` | `cloudflare/cloudflared:latest` | Cloudflare Tunnel 유지 (포트포워딩 없음) |
| `hoster-traefik` | `traefik:v3.2` | docker label 기반 라우팅. 앱 컨테이너는 `hoster-net` 네트워크에 참여 |
| `hoster-deployer` | `hoster-deployer:latest` | 배포 API 서버 (아래 "deployer 이미지 빌드/배포" 참고) |

세 컨테이너 모두 `hoster-net`(init이 생성하는 external 네트워크)에 연결되며,
`stack/docker-compose.yml`에는 `hoster-deployer:latest`에 대한 `build:` 섹션이 없습니다 —
이 이미지는 NAS에서 빌드되지 않고 아래처럼 별도로 전달됩니다.

### 앱 배포 흐름 (`hoster add`로 등록한 레포를 push했을 때)

```
[로컬] git push (hoster add --branch로 지정한 브랜치, 기본 main)
   │
[GitHub Actions] docker/build-push-action → ghcr.io/<owner>/<repo>:<sha>, :latest
   │  POST https://hoster.<baseDomain>/deploy
   │  헤더: x-hoster-timestamp, x-hoster-signature = HMAC-SHA256(`${ts}.${body}`, HOSTER_DEPLOY_SECRET)
[Cloudflare Tunnel] → NAS의 hoster-deployer
   │
[deployer] ghcr.io pull (GHCR_PAT 인증)
   → 기존 hoster-<project> 컨테이너를 hoster-<project>-old로 rename한 뒤 즉시 정지
     (rename은 Docker 라벨을 바꾸지 않아 old가 새 컨테이너와 같은 Traefik 라우터를
     그대로 유지하므로, 정지시켜 Traefik 등록에서 바로 제외한다)
   → 새 이미지로 hoster-<project> 컨테이너 기동 (Traefik label 자동 부착)
   → 헬스체크: http://hoster-<project>:<port><healthPath> (기본 60초, 1초 간격 재시도)
   → 성공 시: old 컨테이너 제거 + 현재/직전 이미지 갱신 + 직전-1 이미지 삭제
   → 실패 시: 새 컨테이너 제거 + old를 원래 이름으로 rename하고 다시 시작(start) + 배포 이력에 failed 기록
```

**의도된 트레이드오프**: old 컨테이너를 rename 직후 정지시키기 때문에, 검증되지 않은 새
버전으로 트래픽이 새는 대신 스왑 도중 해당 프로젝트가 짧게 완전히 응답하지 않는
구간이 생깁니다 — 정상 배포는 새 컨테이너가 뜨는 수 초, 헬스체크 실패로 롤백되는
경우에는 최대 60초(헬스체크 타임아웃)까지입니다.

### 사용자 트래픽 흐름

```
브라우저 → Cloudflare(DNS + 프록시) → Cloudflare Tunnel → Traefik(hoster-net) → 앱 컨테이너
```

### deployer 이미지 빌드/배포 (앱 이미지와는 다른 별도 경로)

NAS의 docker bridge 네트워크는 과거 외부 통신이 되지 않았던 이력이 있어, `hoster-deployer`
이미지는 **NAS에서 직접 빌드하지 않습니다.** 대신 `hoster init` 실행 시 개발자의 Mac에서
빌드한 뒤 이미지를 그대로 전송합니다.

```
[개발자 Mac] docker buildx build --platform linux/amd64 \
             -f packages/deployer/Dockerfile -t hoster-deployer:latest --load .
   │  docker save hoster-deployer:latest | gzip
   │  ssh -p <port> <user>@<NAS> 'gunzip | sudo -n /usr/local/bin/docker load'
[NAS] docker compose --env-file .env up -d   # docker-compose.yml은 image만 참조, build 없음
```

### hoster init 부트스트랩 절차 (정확히 12단계)

`hoster init --dry-run`으로 실행 전 아래 계획을 그대로 확인할 수 있습니다.

1. NAS 접속 및 docker 권한 사전 점검 (로컬에서 ssh로 `docker version` 확인)
2. NAS `docker compose` 플러그인 확인
3. Cloudflare 터널 `hoster` 생성 — 같은 이름의 터널이 이미 있으면 재사용/삭제 후 재생성/중단을
   물어봅니다 (기본값 재사용). `--reuse-tunnel <id>`를 지정하면 조회와 프롬프트를 건너뜁니다
4. 터널 인그레스 설정: `hoster.<baseDomain>` → deployer, `*.<baseDomain>` → traefik
5. DNS CNAME 설정: `hoster.<baseDomain>` → `<터널ID>.cfargotunnel.com`
6. `hoster-net` docker 네트워크 생성 (이미 있으면 무시)
7. NAS 상태 디렉터리(`/volume1/docker/hoster/state/env`) 준비 + `stack/` 전송 (tar over ssh)
8. 로컬에서 deployer 이미지를 `linux/amd64`로 빌드 후 NAS로 전송
9. NAS에 `.env` 작성(0600 권한, `TUNNEL_TOKEN`/`HMAC_SECRET`/`GHCR_PAT`/`BASE_DOMAIN`) + `docker compose up -d`
10. `~/.hoster/config.json` 저장 (0600 권한) — healthz 확인보다 먼저 저장하므로, 11~12단계가
    실패해도(전파 지연 등) 로컬에 시크릿/터널ID가 남아 재시도 시 터널 이름 충돌을 피할 수 있음
11. `hoster-net`에서 외부 통신 진단 (실패 시 경고만 출력하지만 무시 가능한 실패가 아님 —
    cloudflared 자체가 hoster-net에서 외부 통신이 필요하므로 이 진단이 실패하면 12단계
    healthz도 반드시 실패함)
12. 터널 경유 `https://hoster.<baseDomain>/healthz` 확인 (10초 간격 최대 6회 재시도)

실행 중에는 각 단계의 진행 상황을 표시합니다. 터미널(TTY)에서는 한 줄을 스피너와 경과
시간으로 갱신하고, 완료되면 그 줄을 결과로 마감합니다:

```
⠙ [8/12] deployer 이미지 빌드(linux/amd64) 후 NAS로 전송 42.7초
✓ [8/12] deployer 이미지 빌드(linux/amd64) 후 NAS로 전송 96.3초
⠹ [12/12] healthz 확인 — 재시도 2/6 11.4초
```

이미지 빌드·전송과 healthz 재시도는 수십 초에서 수 분이 걸리므로, 표시가 없으면 멈춘 것으로
오해하기 쉽습니다. 파이프/CI처럼 TTY가 아닌 환경에서는 제어 문자를 쓰지 않고 시작·완료를
한 줄씩 남깁니다. `hoster add`(GitHub 시크릿/DNS/프로젝트 등록)와 deployer 응답을 기다리는
`hoster rollback`, `hoster env --redeploy`에도 같은 표시가 적용됩니다.

## 요구 사항

- Node.js 22, pnpm (workspace)
- buildx를 지원하는 로컬 Docker (deployer 이미지를 `linux/amd64`로 빌드해 NAS로 전송하는 데 사용 — NAS 자체에서는 빌드하지 않음)
- GitHub CLI(`gh`), `gh auth login`으로 인증 완료 상태 (`hoster add`가 레포 시크릿 설정에 사용)
- NAS(Synology, Container Manager) SSH 접속 권한: 키 인증 + `sudo -n /usr/local/bin/docker` NOPASSWD 권한
- Cloudflare API 토큰: `Zone.DNS Edit` + `Account.Cloudflare Tunnel Edit` 스코프
- GitHub PAT(`read:packages` 권한) — NAS deployer가 ghcr.io private 이미지를 pull할 때 사용 (각 레포 CI의 `GITHUB_TOKEN` 인증과는 별개)

## 설치

```bash
pnpm install
pnpm build
```

빌드 산출물:
- `packages/cli/dist/index.js` — `hoster` CLI 엔트리 (`packages/cli/dist/templates/`에 workflow/Dockerfile 템플릿이 함께 복사됨)
- `packages/deployer/dist/index.js` — NAS deployer 엔트리 (`packages/deployer/Dockerfile`로 이미지 빌드)

검증: `pnpm test` (vitest, `packages/cli`·`packages/deployer` 각각 실행).

### NAS 접속 정보 지정

`hoster init`은 NAS SSH 접속 정보를 아래 환경변수에서 읽습니다. 미지정 시 예시값(`192.168.1.100`, `22`, `admin`)이 사용되므로 실행 전 실제 값을 지정하세요.

```bash
export HOSTER_NAS_HOST=<NAS IP 또는 호스트명>
export HOSTER_NAS_PORT=<SSH 포트>
export HOSTER_NAS_USER=<SSH 계정>
```

`hoster init`이 끝나면 이 값이 `~/.hoster/config.json`(권한 `0600`)에 저장되므로 이후 명령에서는 환경변수가 필요 없습니다.

## 커맨드

| 커맨드 | 설명 | 옵션 |
|---|---|---|
| `hoster init` | NAS에 hoster 스택(cloudflared/traefik/deployer)을 설치하고 Cloudflare 터널/DNS/HMAC 시크릿을 구성합니다 | `--dry-run`, `--stack-dir <dir>`(기본 `stack/`), `--reuse-tunnel <id>` |
| `hoster add` | 현재 디렉터리의 GitHub 레포를 등록합니다. Dockerfile(Next.js면 자동 생성)·workflow 파일 생성, `gh secret set`, DNS CNAME, 프로젝트 등록까지 수행합니다 | `--branch <branch>`(기본 `main`), `--project <name>`, `--dry-run`, `--force`(기존 workflow 파일 덮어씀) |
| `hoster ls` | 등록된 프로젝트 목록과 현재 이미지를 표시합니다 | – |
| `hoster status <project>` | 프로젝트 상세 정보와 최근 배포 이력을 표시합니다 | – |
| `hoster logs <project>` | 컨테이너 로그를 표시합니다 | `--tail <n>`(기본 `200`) |
| `hoster rollback <project>` | 직전 이미지로 롤백합니다 | – |
| `hoster env set <pairs...>` | 환경변수를 설정합니다 (`KEY=VALUE ...`) | `--project <name>`(기본: 현재 레포에서 추론), `--redeploy`(변경 후 현재 이미지로 재배포) |
| `hoster env rm <keys...>` | 환경변수를 제거합니다 | `--project <name>` |
| `hoster remove <project>` | 프로젝트를 제거합니다 (deployer 등록/컨테이너 + DNS 레코드). 도메인은 관례로 추정하지 않고 deployer에 저장된 실제 값을 조회해 삭제합니다 | – |
| `hoster doctor` | NAS 접속/docker 권한/`hoster-net` 외부 통신 상태를 점검합니다 (상태 변경 없음). `~/.hoster/config.json`을 읽으므로 `hoster init`을 먼저 실행해야 합니다 | – |

`hoster env`는 `set`/`rm` 하위 커맨드를 가진 그룹 커맨드이며, 위 표는 전체 9개 최상위 동작(그룹 내 2개 포함)을 모두 나열한 것입니다.

## 트러블슈팅

- `hoster doctor`: NAS SSH/docker 권한, `docker compose` 플러그인, `hoster-net` 외부 통신을 재점검합니다. `hoster init`이 만드는 계획 중 상태를 바꾸는 액션(터널/DNS 생성, 이미지 빌드/전송, `.env` 작성)은 절대 실행하지 않습니다.
- **NAS 아키텍처**: deployer 이미지는 `linux/amd64`로 고정 빌드됩니다. `hoster init` 실행 전 NAS에서 `uname -m` 결과가 `x86_64`(또는 호환)인지 반드시 확인하세요.
- **`hoster-net`(docker bridge) 외부 통신 불가 이력**: init 11단계에서 자동 진단하며 실패해도 경고만 출력하고 계속 진행하지만, 무시해도 되는 실패가 아닙니다. `hoster-cloudflared` 자체가 `hoster-net` 위에서 실행되며 Cloudflare로 나가는 외부 통신이 반드시 필요하므로, 이 진단이 실패하면 터널이 연결되지 않아 12단계 healthz 확인도 반드시 실패합니다 — DSM 방화벽/IP forward 설정을 반드시 해결해야 합니다.
- **`hoster add`의 브랜치/프로젝트명 제한**: `--branch`는 영숫자와 `. _ / -`만 허용하는 보수적인 부분집합(유니코드, `+`, 공백, 따옴표 등은 거부)으로 검증됩니다 — `.github/workflows/hoster-deploy.yml` 템플릿에 YAML 문자열과 셸 이중따옴표 문자열 양쪽으로 그대로 삽입되기 때문입니다. `--project`도 서버가 요구하는 규칙과 동일하게 소문자/숫자/하이픈, 63자 이하, 첫 글자 영숫자로 제한됩니다.
- **`HMAC_SECRET` 재생성 주의**: `hoster init`을 재실행하면 `HMAC_SECRET`이 새로 생성됩니다. 이미 `hoster add`로 등록된 레포의 `HOSTER_DEPLOY_SECRET`(GitHub 시크릿)은 이전 값 그대로 남아 무효화되므로, 재실행 후에는 각 레포에서 `hoster add`(또는 수동 `gh secret set`)를 다시 실행해 시크릿을 동기화해야 합니다.
- **Cloudflare 터널 이름 충돌**: `hoster init`을 재시도하면 기존 `hoster` 터널을 스스로 찾아 재사용/삭제 후 재생성/중단 중 무엇을 할지 물어봅니다 — 대시보드에서 터널 ID를 찾아올 필요가 없습니다. 기본값은 재사용이고, 활성 커넥션이 붙어있는 터널을 삭제할 때만 `yes` 확인을 한 번 더 받습니다. 비대화형 실행(파이프/CI)에서는 묻지 않고 재사용합니다. 조회 권한이 없어 확인에 실패하면 경고 후 생성을 시도하고, 그때 이름 충돌이 나면 `hoster init --reuse-tunnel <터널ID>` 안내를 출력합니다.
- 배포/롤백/재배포 실패 메시지(`hoster rollback`, `hoster env set --redeploy`)는 deployer가 반환한 JSON의 `error` 필드를 그대로 보여줍니다.

## 실제 인프라 검증

이 저장소의 자동 테스트는 단위 테스트(vitest, dockerode/Cloudflare API 모킹)와 `--dry-run` 계획 검증까지만 다룹니다.
실제 NAS·Cloudflare·GitHub를 사용하는 end-to-end 검증은 [`docs/e2e-checklist.md`](docs/e2e-checklist.md)를 참고해 운영자가 직접 수행합니다.
