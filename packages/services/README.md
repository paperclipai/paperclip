# `packages/services/`

Long-running containerized services that live alongside paperclip — but aren't
TypeScript MCP plugins (`packages/plugins/`) or adapter packages
(`packages/adapters/`). Services may be **any language** (Python, Node, Go…)
and ship as **container images** that the operator deploys via cluster yaml in
the separate `onprem-k8s` repo.

## Why this directory exists

Before BLO-6870, services like `figma-designer-bot` and `webflow-designer-bot`
embedded their 1000-line Python programs directly as ConfigMap data fields in
cluster yaml. That pattern has no review unit, no CI, no isolation between
infra yaml and bot logic. Real concurrency bugs shipped (figma-bot's
chicken-and-egg in v0.3) because the script had no test surface.

`packages/services/` brings each service into the monorepo so it has the same
gating every other paperclip code has: lint, type-check, unit tests, Docker
build, image push to Harbor — all behind the standard PR CI before any
operator runs `kubectl apply`.

## Pattern

Each service is a **self-contained directory** with:

```
<service-name>/
├── README.md           # how to dev/test/build locally
├── Dockerfile          # built by CI, pushed to Harbor
├── pyproject.toml      # (Python services) — pytest/ruff/mypy + entry point
│  OR package.json      # (Node services) — local lockfile, NOT a workspace member
├── src/<package>/      # source modules
├── tests/              # pytest / vitest / etc.
└── (CI lives at paperclip/.github/workflows/docker-<service>.yml)
```

## Not a pnpm workspace member

Services are excluded from the root pnpm workspace via `!packages/services/**`
in `pnpm-workspace.yaml`. Reasons:

- Some are Python (no pnpm relevance)
- Node services here keep their own local `package-lock.json` to insulate the
  paperclip root `pnpm-lock.yaml` from third-party deps
- Services are released independently (per-service image tag, per-service CI)

## CI

Each service gets a dedicated workflow at
`paperclip/.github/workflows/docker-<service>.yml`, modeled on
`docker-mcp-gateway.yml`:

- Triggered by `push` to master + `paths: packages/services/<service>/**`
- Runs unit tests / lint as a pre-build step
- Builds + pushes the image to
  `harbor.blockcast.net/paperclip-<service>/<service>:<sha-tag>` plus
  `:latest` on master
- **Does not auto-deploy.** Cluster yaml cutover (image tag bump in the
  matching `onprem-k8s/paperclip/<service>.yaml`) stays a separate operator
  step.

## Services tracked here

| Service | Language | Cluster deployment |
|---|---|---|
| `webflow-bot/` | Python | `onprem-k8s/paperclip/webflow-designer-bot.yaml` |
| `figma-bot/` | Python | `onprem-k8s/paperclip/figma-designer-bot.yaml` |
| `designer/` | TypeScript | (see service README) |

## How to add a new service

1. `mkdir packages/services/<name>/`
2. Author `Dockerfile`, `pyproject.toml` (or `package.json`), `README.md`
3. Add `paperclip/.github/workflows/docker-<name>.yml` (copy
   `docker-mcp-gateway.yml`, retarget paths + image name + add test step)
4. Land via PR. CI builds + pushes the first image.
5. In a follow-up `onprem-k8s` PR, swap the cluster yaml's image to point at
   the new Harbor path. If the service previously embedded its source in a
   ConfigMap, delete that ConfigMap + the script volume mount in the same PR.
