# hoster

English | [한국어](README.ko.md)

A self-hosting deployment tool that makes a Synology NAS (Container Manager) behave like Vercel.
Push to a registered GitHub repository and GitHub Actions builds a Docker image and pushes it to
ghcr.io; a deployer resident on the NAS pulls that image and swaps the container, and Cloudflare
Tunnel serves it at a public `<project>.<domain>` URL.

- Development deliverables (requirements, architecture, detailed design, API, DB, interfaces, security, test, operations, user manual — written in Korean): [`docs/deliverables/`](docs/deliverables/)
- E2E verification checklist (Korean): [`docs/e2e-checklist.md`](docs/e2e-checklist.md)

## Repository layout

```
hoster/
├── packages/
│   ├── cli/          # hoster CLI (commander, runs on the local Mac)
│   └── deployer/     # deployment API server (Hono + dockerode + better-sqlite3, runs as a container on the NAS)
├── stack/            # docker-compose.yml and .env.example transferred to the NAS
├── templates/        # GitHub Actions workflow and Next.js Dockerfile templates
└── docs/             # deliverable documents, E2E checklist
```

## Architecture

### Resident NAS stack (3 containers, `docker compose`)

| Container | Image | Role |
|---|---|---|
| `hoster-cloudflared` | `cloudflare/cloudflared:latest` | Maintains the Cloudflare Tunnel (no port forwarding) |
| `hoster-traefik` | `traefik:v3.2` | Docker-label based routing. App containers join the `hoster-net` network |
| `hoster-deployer` | `hoster-deployer:latest` | Deployment API server (see "Building and shipping the deployer image" below) |

All three containers attach to `hoster-net`, the external network that `init` creates.
`stack/docker-compose.yml` has no `build:` section for `hoster-deployer:latest` — that image is
never built on the NAS; it is shipped separately as described below.

### App deployment flow (pushing a repository registered with `hoster add`)

```
[local] git push (branch given to hoster add --branch, main by default)
   │
[GitHub Actions] docker/build-push-action -> ghcr.io/<owner>/<repo>:<sha>, :latest
   │  POST https://hoster.<baseDomain>/deploy
   │  headers: x-hoster-timestamp, x-hoster-signature = HMAC-SHA256(`${ts}.${body}`, HOSTER_DEPLOY_SECRET)
[Cloudflare Tunnel] -> hoster-deployer on the NAS
   │
[deployer] pull from ghcr.io (authenticated with GHCR_PAT)
   -> rename the existing hoster-<project> container to hoster-<project>-old and stop it immediately
      (rename does not change Docker labels, so "old" would keep the same Traefik router as the new
      container; stopping it removes it from Traefik's registration right away)
   -> start a hoster-<project> container from the new image (Traefik labels attached automatically)
   -> health check: http://hoster-<project>:<port><healthPath> (60s by default, retried every 1s)
   -> on success: remove the old container, update current/previous image records, delete the image before last
   -> on failure: remove the new container, rename "old" back to its original name and start it again,
      and record the deployment as failed in the history
```

**Intended trade-off**: because the old container is stopped right after the rename, no traffic
leaks to an unverified new version — at the cost of a short window during the swap where the
project does not respond at all. That window is a few seconds for a normal deployment, and up to
60 seconds (the health-check timeout) when a rollback is triggered by a failed health check.

### User traffic flow

```
browser -> Cloudflare (DNS + proxy) -> Cloudflare Tunnel -> Traefik (hoster-net) -> app container
```

### Building and shipping the deployer image (a separate path from app images)

The NAS docker bridge network has a history of losing outbound connectivity, so the
`hoster-deployer` image is **never built on the NAS**. Instead `hoster init` builds it on the
developer's Mac and transfers the image as-is.

```
[developer Mac] docker buildx build --platform linux/amd64 \
                -f packages/deployer/Dockerfile -t hoster-deployer:latest --load .
   │  docker save hoster-deployer:latest | gzip
   │  ssh -p <port> <user>@<NAS> 'gunzip | sudo -n /usr/local/bin/docker load'
[NAS] docker compose --env-file .env up -d   # docker-compose.yml only references the image, never builds
```

### The hoster init bootstrap procedure (exactly 12 steps)

Run `hoster init --dry-run` to see this exact plan before executing it.

1. Pre-check NAS access and docker permissions (`docker version` over ssh from the local machine)
2. Verify the `docker compose` plugin on the NAS
3. Create the Cloudflare tunnel `hoster` — if a tunnel with the same name already exists, you are
   asked whether to reuse it, delete and recreate it, or abort (reuse is the default). Passing
   `--reuse-tunnel <id>` skips both the lookup and the prompt
4. Configure tunnel ingress: `hoster.<baseDomain>` -> deployer, `*.<baseDomain>` -> traefik
5. Configure the DNS CNAME: `hoster.<baseDomain>` -> `<tunnelID>.cfargotunnel.com`
6. Create the `hoster-net` docker network (ignored if it already exists)
7. Prepare the NAS state directory (`/volume1/docker/hoster/state/env`) and transfer `stack/` (tar over ssh)
8. Build the deployer image locally for `linux/amd64` and transfer it to the NAS
9. Write `.env` on the NAS (mode 0600, with `TUNNEL_TOKEN` / `HMAC_SECRET` / `GHCR_PAT` / `BASE_DOMAIN`)
   and run `docker compose up -d`
10. Save `~/.hoster/config.json` (mode 0600) — this happens before the healthz check, so even if
    steps 11–12 fail (propagation delay and the like) the secrets and tunnel ID remain locally and
    a retry avoids a tunnel name collision
11. Diagnose outbound connectivity from `hoster-net` (a failure only prints a warning, but it is not
    a failure you can ignore — cloudflared itself needs outbound connectivity on hoster-net, so if
    this diagnosis fails, the step 12 healthz check is guaranteed to fail too)
12. Verify `https://hoster.<baseDomain>/healthz` through the tunnel (up to 6 retries, 10s apart)

Progress is displayed for each step while it runs. On a TTY a single line is refreshed with a
spinner and elapsed time, then closed out with the result:

```
⠙ [8/12] build the deployer image (linux/amd64) and transfer it to the NAS 42.7s
✓ [8/12] build the deployer image (linux/amd64) and transfer it to the NAS 96.3s
⠹ [12/12] healthz check — retry 2/6 11.4s
```

Image build/transfer and healthz retries take tens of seconds to several minutes, so without this
display it is easy to mistake the tool for hung. In non-TTY environments (pipes, CI) no control
characters are used — start and completion are each written as their own line. The same display
applies to `hoster add` (GitHub secrets / DNS / project registration) and to the commands that wait
on a deployer response, `hoster rollback` and `hoster env --redeploy`.

## Requirements

- Node.js 22, pnpm (workspace)
- A local Docker with buildx support (used to build the deployer image for `linux/amd64` and transfer it to the NAS — the NAS itself never builds)
- GitHub CLI (`gh`), authenticated via `gh auth login` (`hoster add` uses it to set repository secrets)
- SSH access to the NAS (Synology, Container Manager): key authentication plus `sudo -n /usr/local/bin/docker` NOPASSWD permission
- A Cloudflare API token with the `Zone.DNS Edit` and `Account.Cloudflare Tunnel Edit` scopes
- A GitHub PAT with `read:packages` — used by the NAS deployer to pull private images from ghcr.io (separate from the `GITHUB_TOKEN` used by each repository's CI)

## Installation

```bash
pnpm install
pnpm build
```

Build output:
- `packages/cli/dist/index.js` — the `hoster` CLI entry point (workflow/Dockerfile templates are copied alongside it into `packages/cli/dist/templates/`)
- `packages/deployer/dist/index.js` — the NAS deployer entry point (image built from `packages/deployer/Dockerfile`)

Verification: `pnpm test` (vitest, run separately for `packages/cli` and `packages/deployer`).

### Specifying NAS connection details

`hoster init` reads the NAS SSH connection details from the environment variables below. If they are
unset, example values (`192.168.1.100`, `22`, `admin`) are used, so specify the real values before
running it.

```bash
export HOSTER_NAS_HOST=<NAS IP or hostname>
export HOSTER_NAS_PORT=<SSH port>
export HOSTER_NAS_USER=<SSH account>
```

Once `hoster init` finishes, these values are stored in `~/.hoster/config.json` (mode `0600`), so
later commands do not need the environment variables.

## Commands

| Command | Description | Options |
|---|---|---|
| `hoster init` | Installs the hoster stack (cloudflared/traefik/deployer) on the NAS and configures the Cloudflare tunnel, DNS and HMAC secret | `--dry-run`, `--stack-dir <dir>` (default `stack/`), `--reuse-tunnel <id>` |
| `hoster add` | Registers the GitHub repository in the current directory. Creates the Dockerfile (generated automatically for Next.js) and workflow file, runs `gh secret set`, sets the DNS CNAME, and registers the project | `--branch <branch>` (default `main`), `--project <name>`, `--dry-run`, `--force` (overwrite an existing workflow file) |
| `hoster ls` | Lists registered projects and their current images | – |
| `hoster status <project>` | Shows project details and recent deployment history | – |
| `hoster logs <project>` | Shows container logs | `--tail <n>` (default `200`) |
| `hoster rollback <project>` | Rolls back to the previous image | – |
| `hoster env set <pairs...>` | Sets environment variables (`KEY=VALUE ...`) | `--project <name>` (default: inferred from the current repository), `--redeploy` (redeploy the current image after the change) |
| `hoster env rm <keys...>` | Removes environment variables | `--project <name>` |
| `hoster remove <project>` | Removes a project (deployer registration/container plus the DNS record). The domain is never guessed by convention — the actual value stored in the deployer is looked up and deleted | – |
| `hoster doctor` | Checks NAS access, docker permissions and `hoster-net` outbound connectivity (changes no state). It reads `~/.hoster/config.json`, so `hoster init` must have run first | – |

`hoster env` is a group command with the `set` and `rm` subcommands; the table above lists all nine
top-level operations (including the two inside the group).

## Troubleshooting

- `hoster doctor`: re-checks NAS SSH/docker permissions, the `docker compose` plugin and `hoster-net` outbound connectivity. It never runs any state-changing action from the `hoster init` plan (tunnel/DNS creation, image build/transfer, writing `.env`).
- **NAS architecture**: the deployer image is always built for `linux/amd64`. Before running `hoster init`, confirm that `uname -m` on the NAS reports `x86_64` (or a compatible architecture).
- **History of `hoster-net` (docker bridge) losing outbound connectivity**: step 11 of init diagnoses this automatically and only warns on failure, but it is not a failure you can ignore. `hoster-cloudflared` itself runs on `hoster-net` and must reach Cloudflare, so if this diagnosis fails the tunnel will not connect and the step 12 healthz check is guaranteed to fail — you must fix the DSM firewall / IP forwarding settings.
- **Branch and project name restrictions in `hoster add`**: `--branch` is validated against a conservative subset allowing only alphanumerics and `. _ / -` (Unicode, `+`, whitespace, quotes and so on are rejected) — it is inserted verbatim into the `.github/workflows/hoster-deploy.yml` template both as a YAML string and inside a double-quoted shell string. `--project` is restricted to the same rules the server requires: lowercase letters, digits and hyphens, at most 63 characters, starting with an alphanumeric.
- **Caution when `HMAC_SECRET` is regenerated**: re-running `hoster init` generates a new `HMAC_SECRET`. The `HOSTER_DEPLOY_SECRET` GitHub secret in repositories already registered with `hoster add` keeps the old value and is therefore invalidated — after a re-run, run `hoster add` again (or `gh secret set` manually) in each repository to resynchronize the secret.
- **Cloudflare tunnel name collisions**: on a retry, `hoster init` finds the existing `hoster` tunnel itself and asks whether to reuse it, delete and recreate it, or abort — you never need to look up the tunnel ID in the dashboard. Reuse is the default, and a second `yes` confirmation is required only when deleting a tunnel with active connections. Non-interactive runs (pipes, CI) reuse it without asking. If the lookup fails for lack of permission, it warns and attempts creation; if that hits a name collision, it prints guidance to run `hoster init --reuse-tunnel <tunnelID>`.
- Deployment/rollback/redeploy failure messages (`hoster rollback`, `hoster env set --redeploy`) show the `error` field from the deployer's JSON response verbatim.

## Verification against real infrastructure

The automated tests in this repository cover unit tests only (vitest, with dockerode and the
Cloudflare API mocked) plus `--dry-run` plan verification. End-to-end verification against a real
NAS, Cloudflare and GitHub is performed by the operator following
[`docs/e2e-checklist.md`](docs/e2e-checklist.md).
