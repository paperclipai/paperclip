# Shangrila

ValCtrl's internal fork of [Paperclip](https://github.com/paperclipai/paperclip) ? open-source orchestration for AI-agent companies.

Named after the mythical hidden valley: a self-sustaining paradise that runs itself.

## What This Is

Shangrila is Paperclip with ValCtrl-specific customizations layered on top. All upstream Paperclip documentation (`doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, `doc/DATABASE.md`) remains authoritative for core behavior.

This document covers only what differs from upstream.

## Git Topology

| Remote | URL | Purpose |
|--------|-----|---------|
| `origin` | `github.com/valctrltech/shangrila` | Our fork |
| `upstream` | `github.com/paperclipai/paperclip` | Source of truth |

### Branches

| Branch | Role |
|--------|------|
| `master` | Untouched mirror of upstream. Never commit directly. Merge source only. |
| `shangrila/main` | **Default branch.** All ValCtrl customizations live here. |
| `shangrila/feat-*` | Feature branches for individual changes, merged into `shangrila/main`. |

### Upstream Sync Workflow

Run after each upstream tagged release, or monthly minimum:

```sh
git checkout master
git fetch upstream
git merge upstream/master --ff-only
git push origin master

git checkout shangrila/main
git merge master --no-edit
# resolve conflicts if any
pnpm install
pnpm -r typecheck
pnpm test:run
git push origin shangrila/main
```

## Customization Layering

To minimize merge conflicts on upstream sync, place changes in the lowest-conflict zone possible:

| Risk | Area | Rule |
|------|------|------|
| Zero | `skills/` | New files only. Additive. |
| Zero | `packages/plugins/` | New plugin packages. |
| Zero | `packages/adapters/` | New adapter packages. |
| Zero | `.cursor/rules/` | Cursor-specific rules. |
| Low | `docker/`, deploy configs, `.env.*` | Infra-specific. Upstream rarely changes these. |
| Medium | `server/` | Prefer new files. Avoid modifying existing routes/services. |
| Medium | `packages/db/` | New tables safe. Modifying existing table schemas = conflict risk. |
| High | `ui/` | Upstream iterates fast. Keep patches minimal and isolated. |
| High | `packages/shared/` | Core type contracts. Modifications ripple across all layers. |

When modifying upstream files is unavoidable, keep the diff small and explain the reason in the commit message.

## Deployment

Shangrila runs on an existing AWS EC2 instance via Docker.

| Setting | Value |
|---------|-------|
| Database | Embedded PGlite (no `DATABASE_URL` set) |
| Data persistence | Host volume `/opt/shangrila/data` ? container `/paperclip` |
| Port | 3100 |
| Auth | Google OAuth via Better Auth |
| Deployment mode | `authenticated` / `private` |
| Agent keys | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` as container env vars |
| Auto-backup | Every 60 min, 30-day retention (built-in) |

### Running the Container

```sh
docker build -t shangrila .

docker run -d \
  --name shangrila \
  --restart unless-stopped \
  -p 3100:3100 \
  -v /opt/shangrila/data:/paperclip \
  -e HOST=0.0.0.0 \
  -e PORT=3100 \
  -e SERVE_UI=true \
  -e PAPERCLIP_HOME=/paperclip \
  -e PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  -e PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  -e GOOGLE_CLIENT_ID="..." \
  -e GOOGLE_CLIENT_SECRET="..." \
  -e BETTER_AUTH_SECRET="..." \
  -e ANTHROPIC_API_KEY="..." \
  -e OPENAI_API_KEY="..." \
  shangrila
```

### Updating

```sh
cd /path/to/shangrila
git pull origin shangrila/main
docker build -t shangrila .
docker stop shangrila && docker rm shangrila
# re-run docker run command above
```

## Local Development

```sh
pnpm install
pnpm dev
```

API + UI at `http://localhost:3100`. Uses embedded PGlite locally ? no external database needed.

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## Verification

Before any PR or merge:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Current Customizations

1. **Google OAuth login** ? Better Auth integration for Google sign-in (`feat/google-oauth-login`).
2. **AWS EC2 deployment** ? Docker container on existing EC2 with embedded PGlite.
3. **ValCtrl skills and rules** ? custom agent skills and Cursor rules for internal workflows.
