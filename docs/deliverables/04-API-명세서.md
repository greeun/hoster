# API 명세서

## 문서 정보

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-08-13 |
| 버전 | 1.0 |
| 대상 | `packages/deployer` (Hono 기반 HTTP API) |
| 소스 근거 | `packages/deployer/src/app.ts`, `packages/deployer/src/hmac.ts`, `packages/deployer/src/orchestrator.ts`, `packages/deployer/src/store.ts`, `packages/deployer/src/index.ts` |

## 공통 사항

### Base URL

- 터널 경유: `https://hoster.<baseDomain>`
- `baseDomain` 기본값: `example.com` (`process.env.BASE_DOMAIN ?? 'example.com'`, `packages/deployer/src/index.ts`)
- 리스닝 포트: `process.env.PORT ?? 8080`

### 인증

- 적용 범위: `GET /healthz`를 제외한 전 라우트
- `/healthz`는 인증 미들웨어(`app.use('*', ...)`)보다 먼저 등록되어 있어 서명 없이 응답 (라우트 등록 순서에 의존하는 의도된 예외)
- 요청 헤더

| 헤더 | 내용 |
|---|---|
| `x-hoster-timestamp` | 요청 시각(ms epoch, 문자열) |
| `x-hoster-signature` | HMAC-SHA256 서명 값(hex) |

- 서명 대상 문자열: `${timestampMs}.${rawBody}`
- GET/DELETE 요청: `rawBody`는 빈 문자열(`''`)로 서명 (`['GET', 'DELETE'].includes(c.req.method) ? '' : await c.req.text()`)
- 서명 생성 함수 (`packages/deployer/src/hmac.ts`)

```ts
export function signPayload(body: string, timestampMs: number, secret: string): string {
  return createHmac('sha256', secret).update(`${timestampMs}.${body}`).digest('hex');
}
```

- 검증 로직 (`verifySignature`)
  - `timestampMs`가 `Number.isFinite`가 아니면 실패
  - 허용 오차(`maxSkewMs`) 기본값 `300_000`ms(5분): `Math.abs(nowMs - timestampMs) > maxSkewMs`면 실패
  - 서명 비교는 `timingSafeEqual` 사용, 길이 불일치 시 즉시 실패
- 검증 실패 시: `401 { "error": "invalid signature" }`

### 프로젝트명 검증 정규식

```
/^[a-z0-9][a-z0-9-]{0,62}$/
```

- 적용 지점: `POST /deploy`의 `project`, `POST /projects`의 `name`, `DELETE /projects/:name`의 `:name`, `GET /status/:project`의 `:project`, `GET /logs/:project`의 `:project`, `POST /rollback/:project`의 `:project`, `PUT /env/:project`의 `:project`

### 도메인(hostname) 검증 정규식

```
/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i
```

- 적용 지점: `POST /projects`의 `domain` (미지정 시 `${name}.${baseDomain}`으로 기본 생성 후 동일 검증 적용)

### env 키 검증 정규식

```
/^[A-Za-z_][A-Za-z0-9_]*$/
```

- 적용 지점: `PUT /env/:project`의 `set` 객체 키

### 인증 예외

- `GET /healthz`: 서명 헤더 불필요

---

## 엔드포인트별 명세

### GET /healthz

- 인증: 불필요
- 요청 body: 없음
- 성공 응답

```json
{ "ok": true }
```

- 에러 응답: 없음

---

### POST /deploy

- 인증: 필요
- 요청 body

```json
{ "project": "my-app", "image": "ghcr.io/owner/my-app:abc1234", "sha": "abc1234..." }
```

- 검증/에러 조건

| 조건 | 상태 | 응답 |
|---|---|---|
| 서명 검증 실패 | 401 | `{ "error": "invalid signature" }` |
| body JSON 파싱 실패 | 400 | `{ "error": "invalid json" }` |
| `project`가 PROJECT_NAME_RE 불일치 | 400 | `{ "error": "invalid project name" }` |
| `image` 또는 `sha`가 string 아님 | 400 | `{ "error": "invalid body" }` |

- 성공 응답 (`Orchestrator.deploy` 결과, `packages/deployer/src/orchestrator.ts`)

```json
{ "status": "success" }
```

  - `status`: `"success" | "failed" | "skipped"`
  - `status === "failed"` → HTTP 500, 그 외(`success`/`skipped`) → HTTP 200
  - `skipped`: 동일 프로젝트에 대기 중이던 이전 deploy 요청이 최신 요청으로 교체(대체)된 경우
- 실패 응답 예시 (HTTP 500)

```json
{ "status": "failed", "error": "health check failed" }
```

---

### POST /projects

- 인증: 필요
- 요청 body

```json
{
  "name": "my-app",
  "imageRepo": "ghcr.io/owner/my-app",
  "branch": "main",
  "containerPort": 3000,
  "healthPath": "/",
  "domain": "my-app.example.com"
}
```

- 필드별 규칙
  - `name`: 필수, PROJECT_NAME_RE
  - `imageRepo`: 필수, non-empty string
  - `branch`: 선택, string이 아니면 `main`으로 대체(에러 아님)
  - `containerPort`: 선택, number가 아니면 `3000`으로 대체(에러 아님)
  - `healthPath`: 선택, string이 아니면 `/`로 대체(에러 아님)
  - `domain`: 선택, 미지정 시 `${name}.${baseDomain}`으로 생성, 지정/생성된 값 모두 HOSTNAME_RE 검증
- 동작: `store.upsertProject` — 동일 `name`이 이미 있으면 UPDATE(upsert), `ON CONFLICT(name) DO UPDATE`
- 검증/에러 조건

| 조건 | 상태 | 응답 |
|---|---|---|
| 서명 검증 실패 | 401 | `{ "error": "invalid signature" }` |
| body JSON 파싱 실패 | 400 | `{ "error": "invalid json" }` |
| `name`이 PROJECT_NAME_RE 불일치 | 400 | `{ "error": "invalid project name" }` |
| `imageRepo`가 string 아니거나 빈 문자열 | 400 | `{ "error": "invalid imageRepo" }` |
| `domain`(지정값 또는 기본값)이 HOSTNAME_RE 불일치 | 400 | `{ "error": "invalid domain" }` |

- 성공 응답

```json
{ "ok": true }
```

---

### DELETE /projects/:name

- 인증: 필요 (body는 빈 문자열로 서명)
- path param: `name`
- 동작: `docker.stopAndRemove(\`hoster-${name}\`)` 실행 후 `store.removeProject(name)`
  - 등록되지 않은 프로젝트명이어도 컨테이너 정지/삭제(404·304는 무시)와 DELETE는 그대로 시도되며 에러 없이 `200 { "ok": true }` 반환
- 검증/에러 조건

| 조건 | 상태 | 응답 |
|---|---|---|
| 서명 검증 실패 | 401 | `{ "error": "invalid signature" }` |
| `name`이 PROJECT_NAME_RE 불일치 | 400 | `{ "error": "invalid project name" }` |

- 성공 응답

```json
{ "ok": true }
```

---

### GET /status

- 인증: 필요 (body는 빈 문자열로 서명)
- 요청 body: 없음
- 성공 응답 (`store.listProjects()`, 이름순 정렬)

```json
[
  {
    "name": "my-app",
    "imageRepo": "ghcr.io/owner/my-app",
    "domain": "my-app.example.com",
    "branch": "main",
    "healthPath": "/",
    "containerPort": 3000,
    "currentImage": "ghcr.io/owner/my-app:abc1234",
    "previousImage": null
  }
]
```

- 에러 응답: 없음(항상 200, 프로젝트 없으면 `[]`)

---

### GET /status/:project

- 인증: 필요 (body는 빈 문자열로 서명)
- path param: `project`
- 성공 응답 (`{ ...project, deployments }`)

```json
{
  "name": "my-app",
  "imageRepo": "ghcr.io/owner/my-app",
  "domain": "my-app.example.com",
  "branch": "main",
  "healthPath": "/",
  "containerPort": 3000,
  "currentImage": "ghcr.io/owner/my-app:abc1234",
  "previousImage": null,
  "deployments": [
    {
      "id": 3,
      "project": "my-app",
      "image": "ghcr.io/owner/my-app:abc1234",
      "sha": "abc1234...",
      "status": "success",
      "error": null,
      "createdAt": "2026-08-13 04:00:00"
    }
  ]
}
```

  - `deployments`: 최근 20건(`store.listDeployments` 기본 `limit=20`), `id` 내림차순
  - `status`: `"pending" | "success" | "failed" | "rolled_back"`
- 검증/에러 조건

| 조건 | 상태 | 응답 |
|---|---|---|
| 서명 검증 실패 | 401 | `{ "error": "invalid signature" }` |
| `project`가 PROJECT_NAME_RE 불일치 | 400 | `{ "error": "invalid project name" }` |
| 프로젝트 미존재 | 404 | `{ "error": "not found" }` |

---

### GET /logs/:project

- 인증: 필요 (body는 빈 문자열로 서명)
- path param: `project`
- query param: `tail` (선택) — `Number.isInteger(rawTail) && rawTail > 0`이면 그 값, 아니면 기본값 `200`
- 성공 응답: `text/plain` (JSON 아님, `c.text(text)`) — 컨테이너 로그 원문
- 검증/에러 조건

| 조건 | 상태 | 응답 |
|---|---|---|
| 서명 검증 실패 | 401 | `{ "error": "invalid signature" }` |
| `project`가 PROJECT_NAME_RE 불일치 | 400 | `{ "error": "invalid project name" }` |

---

### POST /rollback/:project

- 인증: 필요
- path param: `project`
- 동작: `Orchestrator.rollback(project)` — 직전 이미지(`previousImage`)로 컨테이너 교체
- 성공 응답 (HTTP 200)

```json
{ "status": "success" }
```

- 실패 응답 예시 (HTTP 500, `previousImage` 없는 경우)

```json
{ "status": "failed", "error": "no previous image" }
```

- 검증/에러 조건

| 조건 | 상태 | 응답 |
|---|---|---|
| 서명 검증 실패 | 401 | `{ "error": "invalid signature" }` |
| `project`가 PROJECT_NAME_RE 불일치 | 400 | `{ "error": "invalid project name" }` |
| `result.status === "failed"` (미존재 프로젝트/이전 이미지 없음/헬스체크 실패 등) | 500 | `{ "status": "failed", "error": "..." }` |

---

### PUT /env/:project

- 인증: 필요
- path param: `project`
- 요청 body

```json
{ "set": { "API_KEY": "abc123" }, "remove": ["OLD_KEY"] }
```

  - `set`: 선택, `Record<string,string>` (배열/`null` 불가)
    - 키: ENV_KEY_RE 검증
    - 값: string이어야 하며 `\r`/`\n` 포함 불가
  - `remove`: 선택, `string[]`
- 동작: `<envDir>/<project>.env` 파일을 읽어 기존 키-값에 `set` 병합 후 `remove` 목록 삭제, `mode 0600`으로 재작성(`chmodSync`로 기존 파일도 0600 강제)
- 검증/에러 조건

| 조건 | 상태 | 응답 |
|---|---|---|
| 서명 검증 실패 | 401 | `{ "error": "invalid signature" }` |
| body JSON 파싱 실패 | 400 | `{ "error": "invalid json" }` |
| `project`가 PROJECT_NAME_RE 불일치 | 400 | `{ "error": "invalid project name" }` |
| `set`이 객체가 아니거나 배열/`null` | 400 | `{ "error": "invalid set" }` |
| `set`의 키가 ENV_KEY_RE 불일치 | 400 | `{ "error": "invalid env key: <key>" }` |
| `set`의 값이 string이 아니거나 개행 포함 | 400 | `{ "error": "invalid env value for <key>" }` |
| `remove`가 string 배열이 아님 | 400 | `{ "error": "invalid remove" }` |

- 성공 응답 (병합 후 전체 키 목록)

```json
{ "ok": true, "keys": ["API_KEY", "OTHER_KEY"] }
```

---

## 에러 코드 표

| HTTP 상태 | 발생 조건 | 응답 형태 |
|---|---|---|
| 400 | body JSON 파싱 실패 (모든 body 있는 POST/PUT 라우트 공통, `getBody`) | `{ "error": "invalid json" }` |
| 400 | 프로젝트명이 PROJECT_NAME_RE 불일치 (전 라우트 공통) | `{ "error": "invalid project name" }` |
| 400 | `POST /deploy`의 `image`/`sha`가 string 아님 | `{ "error": "invalid body" }` |
| 400 | `POST /projects`의 `imageRepo`가 string 아니거나 빈 문자열 | `{ "error": "invalid imageRepo" }` |
| 400 | `POST /projects`의 `domain`이 HOSTNAME_RE 불일치 | `{ "error": "invalid domain" }` |
| 400 | `PUT /env/:project`의 `set`이 객체 아님/배열/`null` | `{ "error": "invalid set" }` |
| 400 | `PUT /env/:project`의 `set` 키가 ENV_KEY_RE 불일치 | `{ "error": "invalid env key: <key>" }` |
| 400 | `PUT /env/:project`의 `set` 값이 string 아니거나 개행 포함 | `{ "error": "invalid env value for <key>" }` |
| 400 | `PUT /env/:project`의 `remove`가 string 배열 아님 | `{ "error": "invalid remove" }` |
| 401 | `x-hoster-timestamp`/`x-hoster-signature` 검증 실패(시간 초과·서명 불일치·타임스탬프 비유한) — `/healthz` 제외 전 라우트 | `{ "error": "invalid signature" }` |
| 404 | `GET /status/:project` 대상 프로젝트 미존재 | `{ "error": "not found" }` |
| 500 | `POST /deploy` 결과 `status === "failed"` | `{ "status": "failed", "error": "..." }` |
| 500 | `POST /rollback/:project` 결과 `status === "failed"` | `{ "status": "failed", "error": "..." }` |
