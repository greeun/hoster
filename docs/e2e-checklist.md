# E2E 검증 체크리스트

이 체크리스트는 실제 NAS, Cloudflare, GitHub 인프라를 사용하는 **수동 검증**입니다.
자동화하지 않으며, 실행 권한이 있는 운영자가 직접 위에서부터 순서대로 진행합니다.
실패한 항목은 원인을 해결한 뒤 재시도하고, 전부 통과하기 전에는 완료를 선언하지 않습니다.

명령의 `<baseDomain>`은 `hoster init`에 입력한 기본 도메인(예: `example.com`), `<NAS>`/`<port>`/`<user>`는
NAS 접속 정보로 각자 환경에 맞게 치환합니다.

## 사전 준비

- [ ] 로컬 도구 확인: `node -v`(22.x), `pnpm -v`, `docker buildx version`, `gh --version`
- [ ] gh CLI 로그인 상태 확인: `gh auth status`
- [ ] **NAS 아키텍처 확인** (필수, init 전에 반드시 확인) — deployer 이미지는 `linux/amd64`로 고정 빌드됨:
      `ssh -p <port> <user>@<NAS> 'uname -m'` → `x86_64` 확인
- [ ] NAS SSH/docker 권한 확인: `ssh -p <port> <user>@<NAS> 'sudo -n /usr/local/bin/docker version --format {{.Server.Version}}'`
- [ ] Cloudflare 대시보드에서 API 토큰 발급 (`Zone.DNS Edit` + `Account.Cloudflare Tunnel Edit`), Account ID/Zone ID 확인
- [ ] GitHub PAT 발급 (`read:packages`) — NAS deployer가 ghcr.io private 이미지를 pull할 때 사용
- [ ] 저장소 루트에서 `pnpm install && pnpm build` 실행 — `packages/cli/dist/index.js`, `packages/deployer/dist/index.js` 생성 확인
- [ ] (선택) `pnpm test` — 단위 테스트 통과 확인

## init

- [ ] `hoster init --dry-run` — 12단계 실행 계획이 출력되는지 확인 (사전 점검 → compose 확인 → 터널 생성 → 인그레스 설정 → DNS CNAME → `hoster-net` 생성 → stack 전송 → deployer 이미지 buildx 빌드/전송 → `.env` 작성/`compose up` → **config 저장** → 외부 통신 진단 → healthz 확인). config 저장이 외부 통신 진단/healthz보다 먼저인지 확인 — 순서가 다르면 코드와 문서가 어긋난 것이므로 재확인 필요. `--stack-dir` 기본값이 `stack/`인지 확인
- [ ] `hoster init` 실행 — 프롬프트(기본 도메인, Cloudflare API 토큰/Account ID/Zone ID, GHCR PAT)에 입력 후 완료까지 진행
  - [ ] 각 단계가 `⠙ [n/12] <설명> <경과>초` 형태로 표시되고 완료 시 `✓`로 마감되는지 확인 — 특히 8단계(이미지 빌드/전송)와 12단계(healthz)에서 무출력 구간 없이 진행 상황이 보이는지
  - [ ] healthz 재시도 중 `재시도 n/6`이 표시되는지 확인
  - [ ] 프롬프트가 뜰 때 스피너가 입력 줄을 덮어쓰지 않는지 확인
  - [ ] 파이프로 실행(`hoster init | cat`)하면 제어 문자 없이 시작/완료 줄만 남는지 확인
  - [ ] 같은 이름의 터널이 이미 있으면 CLI가 재사용/삭제 후 재생성/중단을 물어보는지 확인 (대시보드 방문 불필요, 기본값은 재사용). 활성 커넥션이 있는 터널을 삭제하려면 `yes` 확인을 한 번 더 요구하는지 확인
  - [ ] 비대화형 실행(파이프/CI)에서는 묻지 않고 기존 터널을 재사용하며 그 사실을 로그로 남기는지 확인
- [ ] `curl https://hoster.<baseDomain>/healthz` → `{"ok":true}`
- [ ] NAS에서 `sudo -n /usr/local/bin/docker ps` — `hoster-cloudflared` / `hoster-traefik` / `hoster-deployer` 3개 컨테이너 `Up` 상태 확인
- [ ] `~/.hoster/config.json` 파일 생성 및 권한 `0600` 확인 (`stat -f '%A' ~/.hoster/config.json` 등)
- [ ] `hoster doctor` — 변경 없이 NAS 접속/docker 권한/`hoster-net` 외부 통신을 재점검하고 정상 종료하는지 확인

## 배포

- [ ] 샘플 앱 생성: `npx create-next-app@latest hoster-e2e-sample`
- [ ] `next.config.ts`(또는 프로젝트에 맞는 `.js`/`.mjs`/`.cjs`)에 `output: 'standalone'` 설정 추가
- [ ] GitHub 레포 생성 후 push
- [ ] 레포 루트에서 `hoster add` 실행 (필요 시 `--branch <branch>`, `--project <name>` 지정)
  - [ ] `Dockerfile`이 없었다면 Next.js 템플릿으로 자동 생성됐는지 확인
  - [ ] `.github/workflows/hoster-deploy.yml` 생성 확인
  - [ ] `gh secret list --repo <owner>/<repo>`로 `HOSTER_DEPLOY_URL`, `HOSTER_DEPLOY_SECRET` 등록 확인
  - [ ] `hoster add`를 다시 실행했을 때 기존 workflow 파일을 덮어쓰지 않는지, `--force` 지정 시에만 덮어쓰는지 확인
- [ ] 생성 파일 커밋 + push: `git add Dockerfile .github && git commit -m "chore: hoster add" && git push`
- [ ] GitHub Actions 성공 확인 (`docker/build-push-action`으로 `ghcr.io/<owner>/<repo>:<sha>` push 후 deployer `/deploy` 호출이 HTTP 200으로 응답)
- [ ] `curl https://hoster-e2e-sample.<baseDomain>` → Next.js 기본 페이지 응답
  - **의도된 동작**: 배포 중 기존 컨테이너는 rename 직후 즉시 정지되므로(Traefik 이중 등록 방지), 새 컨테이너가 헬스체크를 통과하기까지 수 초간 해당 URL이 완전히 응답하지 않을 수 있습니다 — 무중단 배포가 아니라 짧은 완전 중단을 대가로 검증되지 않은 버전으로의 트래픽 유출을 막는 의도된 트레이드오프입니다. 버그가 아닙니다.
- [ ] `hoster ls` — 프로젝트명/도메인/이미지(짧은 sha) 표시 확인

## 롤백/환경변수

- [ ] 페이지 문구 수정 후 push → Actions 재실행 → `curl`로 새 버전 반영 확인
- [ ] `hoster status hoster-e2e-sample` — 배포 이력에 `success` 2건 확인
- [ ] `hoster rollback hoster-e2e-sample` → `curl`로 이전 문구 복귀 확인, `hoster status`에 `rolled_back` 기록 확인
- [ ] `hoster env set TEST_VAR=hello --project hoster-e2e-sample --redeploy` → 재배포 후 컨테이너에 `TEST_VAR` 반영 확인
- [ ] `hoster env rm TEST_VAR --project hoster-e2e-sample` → 제거 확인 (재배포는 자동으로 일어나지 않으므로, 반영을 확인하려면 별도로 재배포하거나 다음 배포에서 확인)
- [ ] `hoster logs hoster-e2e-sample --tail 50` — 로그 출력 확인

## 실패 경로

- [ ] 의도적으로 빌드를 깨는 커밋 push → Actions 실패, 기존 배포 컨테이너/도메인 응답은 그대로 유지되는지 확인
- [ ] 헬스체크에 실패하는 이미지(기동 즉시 종료하거나 `/`에 응답하지 않는 이미지) 배포 →
  - **의도된 동작(놀라지 말 것)**: 기존 컨테이너는 rename 직후 이미 정지되어 있으므로, 새
    컨테이너의 헬스체크가 실패로 확정되는 최대 60초(헬스체크 타임아웃) 동안 서비스가
    완전히 응답하지 않습니다. 이는 검증 없이 새 버전으로 트래픽이 새는 것을 막기 위한
    의도된 트레이드오프이며, 자동 롤백이 완료되면 정상 응답으로 돌아옵니다.
  - [ ] deployer가 새 컨테이너를 제거하고 기존 컨테이너(`hoster-<project>-old` → 원래 이름으로 rename + 재시작(start))로 자동 롤백하는지 확인 — 최대 60초까지 기다린 뒤 확인
  - [ ] `hoster status hoster-e2e-sample`에 해당 배포가 `failed`로 기록되는지 확인
  - [ ] 서비스가 실패 이전 버전으로 정상 응답하는지 확인

## 정리

- [ ] `hoster remove hoster-e2e-sample` — deployer 등록/컨테이너 제거 + DNS CNAME 레코드 삭제 확인 (관례로 추정한 도메인이 아니라 `hoster status`로 조회했던 실제 도메인이 삭제되는지 확인)
- [ ] workflow 파일(`.github/workflows/hoster-deploy.yml`)은 자동으로 삭제되지 않음을 확인 — 필요 시 레포에서 수동 삭제
- [ ] 필요 시 GitHub 레포 시크릿(`HOSTER_DEPLOY_URL`, `HOSTER_DEPLOY_SECRET`)을 수동으로 정리

## 알려진 위험 요소 (사전 준비 단계에서 먼저 확인)

- **NAS 아키텍처**: deployer 이미지는 `linux/amd64`로 고정 빌드됩니다. NAS가 다른 아키텍처(ARM 등)라면 `hoster init`을 실행하기 전에 `uname -m`으로 반드시 확인해야 합니다.
- **NAS docker bridge 네트워크 외부 통신 불가 이력**: 과거 세션에서 `hoster-net`(docker bridge)이 외부 HTTP 요청을 하지 못한 사례가 있었습니다. `hoster init`의 11번째 단계가 자동으로 진단하며(`hoster-net`에서 `https://one.one.one.one` 요청), 실패해도 init 자체는 경고만 출력하고 계속 진행합니다 — 하지만 이 실패는 무시해도 되는 게 아닙니다. `hoster-cloudflared` 자체가 `hoster-net` 위에서 실행되며 Cloudflare로 나가는 외부 통신이 반드시 필요하므로, 이 진단이 실패하면 터널이 연결되지 않아 다음 단계(healthz 확인)가 반드시 실패합니다. `hoster doctor`로도 동일한 진단을 init 이후 재실행할 수 있습니다. DSM 방화벽/IP forward 설정을 반드시 해결해야 합니다.
- **`hoster add`의 브랜치/프로젝트명 제한**: `--branch`는 영숫자와 `. _ / -`만 허용하는 보수적인 부분집합(유니코드, `+`, 공백, 따옴표 등은 거부)으로 검증됩니다 — 워크플로 템플릿에 YAML/셸 문자열로 그대로 삽입되기 때문입니다. 이런 문자를 쓰는 브랜치명이 있다면 `hoster add`가 거부하는 것이 정상 동작입니다.
- **`hoster init` 재실행 시 `HMAC_SECRET` 재생성**: 재실행할 때마다 새 `HMAC_SECRET`이 생성되어 NAS `.env`와 `~/.hoster/config.json`에 반영됩니다. 이미 `hoster add`로 등록된 레포의 GitHub 시크릿 `HOSTER_DEPLOY_SECRET`은 이전 값 그대로 남아있어 서명 검증에 실패하게 됩니다 — 재실행 후에는 등록된 레포마다 `hoster add`(또는 수동 `gh secret set`)를 다시 실행해 시크릿을 동기화해야 합니다.
