import { Hono, type Context } from 'hono';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { verifySignature } from './hmac.js';
import type { StateStore } from './store.js';
import type { DockerManager } from './docker.js';
import type { Orchestrator } from './orchestrator.js';

interface Deps {
  store: StateStore; docker: DockerManager; orchestrator: Orchestrator;
  secret: string; envDir: string; baseDomain: string;
}

type Variables = { rawBody: string };
type AppEnv = { Variables: Variables };

/** 프로젝트명은 컨테이너명·env 파일 경로·기본 도메인 라벨에 그대로 쓰이므로 DNS 라벨 형태로만 허용한다. */
const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** POST /projects의 domain은 Traefik 라우터 라벨(백틱 규칙)에 그대로 삽입되므로 호스트명 형식만 허용한다. */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
/** .env 파일에 그대로 쓰이는 키는 통상적인 식별자 형태만 허용한다. */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isValidProjectName(name: unknown): name is string {
  return typeof name === 'string' && PROJECT_NAME_RE.test(name);
}

function isValidHostname(domain: unknown): domain is string {
  return typeof domain === 'string' && HOSTNAME_RE.test(domain);
}

/** rawBody를 JSON으로 파싱한다. 실패 시 400 Response를 그대로 반환해 각 라우트의 중복 처리를 없앤다. */
function getBody<T>(c: Context<AppEnv>): T | Response {
  try {
    return JSON.parse(c.get('rawBody')) as T;
  } catch {
    return c.json({ error: 'invalid json' }, 400);
  }
}

export function buildApp(deps: Deps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // /healthz는 아래 인증 미들웨어(app.use('*', ...))보다 먼저 등록되어 있어
  // 서명 없이도 응답한다 — 라우트 등록 순서에 의존하는 의도된 예외(터널/모니터링용).
  app.get('/healthz', (c) => c.json({ ok: true }));

  app.use('*', async (c, next) => {
    if (c.req.path === '/healthz') return next();
    const ts = Number(c.req.header('x-hoster-timestamp'));
    const sig = c.req.header('x-hoster-signature') ?? '';
    const body = ['GET', 'DELETE'].includes(c.req.method) ? '' : await c.req.text();
    if (!verifySignature({ body, timestampMs: ts, signature: sig, secret: deps.secret })) {
      return c.json({ error: 'invalid signature' }, 401);
    }
    c.set('rawBody', body);
    return next();
  });

  app.post('/deploy', async (c) => {
    const body = getBody<{ project?: unknown; image?: unknown; sha?: unknown }>(c);
    if (body instanceof Response) return body;
    const { project, image, sha } = body;
    if (!isValidProjectName(project)) return c.json({ error: 'invalid project name' }, 400);
    if (typeof image !== 'string' || typeof sha !== 'string') {
      return c.json({ error: 'invalid body' }, 400);
    }
    const result = await deps.orchestrator.deploy({ project, image, sha });
    return c.json(result, result.status === 'failed' ? 500 : 200);
  });

  app.post('/projects', (c) => {
    const body = getBody<{
      name?: unknown; imageRepo?: unknown; branch?: unknown;
      containerPort?: unknown; healthPath?: unknown; domain?: unknown;
    }>(c);
    if (body instanceof Response) return body;
    const { name, imageRepo } = body;
    if (!isValidProjectName(name)) return c.json({ error: 'invalid project name' }, 400);
    if (typeof imageRepo !== 'string' || imageRepo.length === 0) {
      return c.json({ error: 'invalid imageRepo' }, 400);
    }
    const domain = body.domain ?? `${name}.${deps.baseDomain}`;
    if (!isValidHostname(domain)) return c.json({ error: 'invalid domain' }, 400);
    deps.store.upsertProject({
      name,
      imageRepo,
      branch: typeof body.branch === 'string' ? body.branch : 'main',
      containerPort: typeof body.containerPort === 'number' ? body.containerPort : 3000,
      healthPath: typeof body.healthPath === 'string' ? body.healthPath : '/',
      domain,
    });
    return c.json({ ok: true });
  });

  app.delete('/projects/:name', async (c) => {
    const name = c.req.param('name');
    if (!isValidProjectName(name)) return c.json({ error: 'invalid project name' }, 400);
    await deps.docker.stopAndRemove(`hoster-${name}`);
    deps.store.removeProject(name);
    return c.json({ ok: true });
  });

  app.get('/status', (c) => c.json(deps.store.listProjects()));

  app.get('/status/:project', (c) => {
    const project = c.req.param('project');
    if (!isValidProjectName(project)) return c.json({ error: 'invalid project name' }, 400);
    const p = deps.store.getProject(project);
    if (!p) return c.json({ error: 'not found' }, 404);
    return c.json({ ...p, deployments: deps.store.listDeployments(p.name) });
  });

  app.get('/logs/:project', async (c) => {
    const project = c.req.param('project');
    if (!isValidProjectName(project)) return c.json({ error: 'invalid project name' }, 400);
    const rawTail = Number(c.req.query('tail'));
    const tail = Number.isInteger(rawTail) && rawTail > 0 ? rawTail : 200;
    const text = await deps.docker.logs(`hoster-${project}`, tail);
    return c.text(text);
  });

  app.post('/rollback/:project', async (c) => {
    const project = c.req.param('project');
    if (!isValidProjectName(project)) return c.json({ error: 'invalid project name' }, 400);
    const result = await deps.orchestrator.rollback(project);
    return c.json(result, result.status === 'failed' ? 500 : 200);
  });

  app.put('/env/:project', (c) => {
    const project = c.req.param('project');
    if (!isValidProjectName(project)) return c.json({ error: 'invalid project name' }, 400);
    const body = getBody<{ set?: unknown; remove?: unknown }>(c);
    if (body instanceof Response) return body;

    const setEntries: [string, string][] = [];
    if (body.set !== undefined) {
      if (typeof body.set !== 'object' || body.set === null || Array.isArray(body.set)) {
        return c.json({ error: 'invalid set' }, 400);
      }
      for (const [k, v] of Object.entries(body.set as Record<string, unknown>)) {
        if (!ENV_KEY_RE.test(k)) return c.json({ error: `invalid env key: ${k}` }, 400);
        if (typeof v !== 'string' || /[\r\n]/.test(v)) {
          return c.json({ error: `invalid env value for ${k}` }, 400);
        }
        setEntries.push([k, v]);
      }
    }
    let removeList: string[] = [];
    if (body.remove !== undefined) {
      if (!Array.isArray(body.remove) || !body.remove.every((x) => typeof x === 'string')) {
        return c.json({ error: 'invalid remove' }, 400);
      }
      removeList = body.remove as string[];
    }

    mkdirSync(deps.envDir, { recursive: true });
    const file = join(deps.envDir, `${project}.env`);
    const current = new Map<string, string>();
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf-8').split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const i = t.indexOf('=');
        if (i > 0) current.set(t.slice(0, i), t.slice(i + 1));
      }
    }
    for (const [k, v] of setEntries) current.set(k, v);
    for (const k of removeList) current.delete(k);
    writeFileSync(
      file,
      [...current.entries()].map(([k, v]) => `${k}=${v}`).join('\n') + '\n',
      { mode: 0o600 }
    );
    // writeFileSync의 mode 옵션은 파일이 새로 생성될 때만 적용되므로,
    // 기존 파일(예: 이전 버전이 0644로 남긴 파일)을 덮어쓸 때도 0600을 강제한다.
    chmodSync(file, 0o600);
    return c.json({ ok: true, keys: [...current.keys()] });
  });

  return app;
}
