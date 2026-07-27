# Fork Notes — valkyriweb/paperclip

This is a customized fork of [`paperclipai/paperclip`](https://github.com/paperclipai/paperclip).
`origin` = `valkyriweb/paperclip`; `upstream` = `paperclipai/paperclip` (push-disabled).
Default branch: **`master`**.

Read this before syncing upstream so fork customizations aren't silently clobbered
or upstream-only machinery re-enabled.

## Deploy chain

```
push to master  →  .github/workflows/docker.yml  →  ghcr.io/valkyriweb/paperclip:sha-<short>
                →  infra/lue-kube/k3s/apps/paperclip/base/app.yaml (image ref)
                →  Flux (kustomization apps-paperclip-prod)  →  lue-kube
```

`master` is the deploy branch. `bermont` and other local branches are historical and
build nothing. The daily/manual `paperclip-image-bump.yml` in lue-kube advances the ref.

## Fork-only workflows (not in upstream — keep on sync)

- `.github/workflows/bermont-clawsweeper-dispatch.yml` — ClawSweeper dispatcher (issues/PRs).
- `.github/workflows/upstream-sync.yml` — weekly upstream → fork sync notice PR.

## Upstream-only CI, intentionally disabled on the fork

Guarded with `if: github.repository_owner == 'paperclipai'` (skips on the fork, still runs
on upstream, stays merge-clean). If a sync drops the guard, re-add it.

- `agent-runtime-images.yml` (job `build-and-sign`) — publishes to `ghcr.io/paperclipai`;
  the fork has no write access, so it failed every master push before this guard.
- `pr.yml` — steps *Validate release package manifest*, *Verify release package bootstrap*,
  *Verify release registry test coverage*, and the `canary_dry_run` job (upstream
  `@paperclipai/*` release-registry machinery). Core typecheck/tests/build lanes still run.
- `release.yml` — `verify_canary` / `verify_stable` (and the publish jobs that need them):
  upstream `@paperclipai/*` npm publish path.

`release-smoke.yml` and `e2e.yml` are `workflow_dispatch`-only (never auto-fire) and are
left runnable so they can be triggered manually if ever needed.

## Source customizations (themes — see `git log upstream/master..master`)

- **Deploy/image:** master-as-deploy-branch, amd64 image build, 1Password CLI + prod
  observability preload deps in the Docker image.
- **Heartbeat / OpenClaw:** provider fallback ladder, keep-alive while waiting,
  openclaw-gateway protocol v4, workspace_finalize op-log FK race fix.
- **Provider/adapter:** pi-adapter rate-limits classified transient, non-UUID run-id
  rejected at trust boundaries.
- **Cost/billing:** the pi-local adapter resolves `billingType` (upstream hardcodes
  `"unknown"`, which suppresses cost estimation and records every subscription run at
  zero), and `MODEL_RATES` covers the models this fleet actually runs
  (`claude-opus-5`, `gpt-5.6-*`). Guarded by `packages/adapters/pi-local/src/server/billing.test.ts`
  and the `fleet model rate coverage (fork)` block in `server/src/__tests__/model-costs.test.ts`
  -- if an upstream sync reverts either half, those tests fail. Rates for models upstream
  does not price are fork estimates; correct the constants if list prices change.
- **Recovery:** suppress stale/paused routine recovery, source-scoped recovery actions.
- **UI:** blocked-inbox row hit targets + optimistic mark-read/unread.
- **CI adaptations:** fork canary publish opt-in, skip Cursor-only tests in fork release
  gate, `sync/**` branches exempt from the manual-lockfile-edit block.

## Syncing upstream

Deliberate, not routine. Merge `upstream/master` into a `sync/master-upstream-<date>`
branch, resolve conflicts (keep both sides), verify the guards above survived, open a PR
filling `.github/PULL_REQUEST_TEMPLATE.md`, then let Docker rebuild the deploy image.
