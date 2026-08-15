# Coolify: switch goc-paperclip to build from this fork

**Owner:** Yaver (Coolify UI only). Do not change Coolify from agents.
**Goal:** Deploy `yaverabbas/paperclip` from Git instead of `npm install -g paperclipai@…`.
**Why:** Deflector ships in this fork; we do not own the `paperclipai` npm scope.

## Current prod (today)

- Coolify project: `goc-paperclip` → environment `production`
- Resource: Docker Compose service (`service-gochd8i70z0sytx42zgc8yc74p8`)
- Image/runtime: `node:20-bookworm-slim` + `npm install -g paperclipai@2026.512.0`
- Domain: `goc.yaaver.com`

## Target

- Build pack: **Dockerfile** (repo root `Dockerfile`)
- Repo: `yaverabbas/paperclip`
- Branch: **`master` only after PR #2 is merged** (Dockerfile must include `make`/`g++` and `packages/adapters/deflector/package.json` in the deps stage). Until then, canary on `feature/deflector-adapter`.
- Base image from Dockerfile: `node:lts-trixie-slim` (Node 24 LTS on the smoke run; newer than prod's Node 20)
- Smoke proof (CI): https://github.com/yaverabbas/paperclip/actions/runs/31866886911 — image build + `better-sqlite3` open/insert/select **success**

## Copy-paste Coolify steps

1. Open https://cf.yaaver.com/ → project **goc-paperclip** → environment **production**.
2. Prefer a **new Application** resource (cleaner than converting the old Compose service):
   - **+ New** → Application → GitHub App / private repo
   - Repository: `yaverabbas/paperclip`
   - Branch: `master`
   - Build Pack: **Dockerfile**
   - Dockerfile location: `/Dockerfile` (repo root)
   - Port: `3100` (matches Dockerfile `EXPOSE 3100`)
   - Domain: `goc.yaaver.com` (move DNS/proxy from the old Compose service after the new app is healthy)
3. Persistent data (critical):
   - Mount a volume at `/paperclip` (Dockerfile sets `PAPERCLIP_HOME=/paperclip`)
   - Migrate/reuse the existing Paperclip data volume currently mounted at `/app/.paperclip` on the Compose service, **or** copy that data into the new volume before cutover
   - Do not start with an empty `/paperclip` unless you intend a fresh instance
4. Environment variables to carry over from the old Compose service / instance config (names may differ slightly; preserve secrets):
   - Auth / deployment mode settings already stored under the instance config are fine if the volume is reused
   - Any extra Compose `environment:` keys used today (API keys, model providers, etc.)
5. Deploy the new Dockerfile app → wait for healthy `GET https://goc.yaaver.com/api/health`
6. Smoke Deflector on the live image (after merge + deploy):
   - Confirm adapter type `deflector_local` appears in the UI/API adapter list
   - Optionally hire Deflector in a throwaway company first (not AIP/ONS yet)
7. Only after health + Deflector adapter visibility: retire/stop the old Compose npm-based service

## What not to do

- Do not publish under `@paperclipai/*` on npm (scope not owned).
- Do not hire Deflector on AIP/ONS until this deploy is live and verified.
- Do not leave both old Compose and new Dockerfile apps bound to `goc.yaaver.com` at once.

## Verification already automated in PR

Workflow: `.github/workflows/deflector-docker-smoke.yml`

- Builds the repo Dockerfile (`node:lts-trixie-slim`)
- Installs native build tools (`make`, `g++`) so `better-sqlite3` can compile when no prebuild exists for that Node ABI
- Runs `better-sqlite3` open/insert/select inside the image
- Resolves `better-sqlite3` from `packages/adapters/deflector`
