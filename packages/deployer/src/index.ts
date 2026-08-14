import { serve } from '@hono/node-server';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StateStore } from './store.js';
import { DockerManager } from './docker.js';
import { Orchestrator } from './orchestrator.js';
import { buildApp } from './app.js';

const secret = process.env.HMAC_SECRET;
if (!secret) {
  console.error('HMAC_SECRET is required');
  process.exit(1);
}

const stateDir = process.env.STATE_DIR ?? '/state';
const envDir = join(stateDir, 'env');
mkdirSync(envDir, { recursive: true });

const store = new StateStore(join(stateDir, 'hoster.db'));
const docker = new DockerManager({
  network: process.env.DOCKER_NETWORK ?? 'hoster-net',
  ghcrPat: process.env.GHCR_PAT,
});
const orchestrator = new Orchestrator({ store, docker, envDir });
const app = buildApp({
  store, docker, orchestrator, secret, envDir,
  baseDomain: process.env.BASE_DOMAIN ?? 'example.com',
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port });
console.log(`hoster-deployer listening on :${port}`);
