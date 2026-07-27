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
  does not price come from the OpenRouter model list (`https://openrouter.ai/api/v1/models`):
  gpt-5.6 is tiered per variant (luna $1/$6, terra $2.50/$15, sol $5/$30 per M in/out, each
  `-pro` matching its base) and `claude-opus-5-fast` is double standard opus-5, so entry
  order matters -- `MODEL_RATES` takes the first match. Re-check that card when prices move.

  The openclaw-gateway adapter recovers usage the same way. The gateway's run-completion
  payload carries no `usage`, `model` or `costUsd` at all, so OpenClaw-backed agents wrote
  no cost event whatsoever (368 runs over 14 days, entirely invisible). OpenClaw does track
  it on the session store entry, projected onto each `sessions.list` row, so the adapter
  samples that before dispatch and after completion and records the difference -- the rows
  carry CUMULATIVE session totals, and a session outlives many runs under the issue/fixed key
  strategies, so writing them undifferenced would over-bill badly. Inline meta is still
  preferred if the gateway ever starts sending it. Guarded by
  `packages/adapters/openclaw-gateway/src/server/billing.test.ts`.

  Deliberately NOT `sessions.usage`, despite the name: that RPC derives usage by scanning the
  session transcript, and these agents run the pi-fork runtime whose transcripts it cannot
  read. Live it returned a row whose `usage` was null while the store entry beside it held
  580k input tokens -- which shipped as two deploys that recorded nothing. `sessions.list`
  rows expose no cache buckets, so cached reads bill at the full input rate (~2% over on
  observed runs); that errs toward over-reporting spend rather than dropping the run.

  Cache buckets are spelled differently on each path, and getting that wrong is silent: the
  run meta says `cacheReadTokens`/`cacheWriteTokens`, the session store says
  `cacheRead`/`cacheWrite`. Matching only the store spelling recorded 695k input tokens
  against ZERO cached tokens on this adapter while other adapters logged 226M. Upstream
  reports the prompt total as `input + cacheRead + cacheWrite`, so input is already exclusive
  of cached reads -- the adapter declares `cachedTokensIncludedInInput: false` rather than
  letting the per-model table guess, because that property belongs to the route, not the model.
  Cache WRITES bill at a premium (Anthropic 1.25x input, OpenAI lane free) and are a separate
  bucket end to end. Prefer the cost the gateway reports: it takes ClawRouter's explicit
  per-call price when present (`readExplicitCostUsd`), which is the actual biller and beat our
  own table by 44% on a live run. Our rate table is a fallback, not the source of truth.

  Four traps worth keeping on OpenClaw upgrades. Under the `run` key strategy every run mints a
  fresh session key, so a pre-dispatch baseline asks about a session that does not exist yet
  and the gateway rejects it -- expected, and only a timeout/method-not-found may mark a
  gateway as lacking the method (`indicatesSessionUsageUnsupported`). Treating that ordinary
  rejection as "unsupported" once disabled billing process-wide for 24 runs. And when no row
  matches, the adapter logs the key and row count rather than recording zero: silent nulls are
  what let two broken deploys look healthy. Third, and the reason to verify against the RUNNING
  gateway rather than an upstream checkout: `sessions.list` params are validated against a
  CLOSED schema, so a single filter the deployed version has not shipped fails the entire call.
  `sortBy` (present upstream, absent in the deployed 2026.7.1) cost a whole deploy its billing.
  Keep params minimal; on a params rejection the adapter retries unfiltered and finds the key
  itself (`indicatesRejectedListParams`).
- **Recovery:** suppress stale/paused routine recovery, source-scoped recovery actions.
- **UI:** blocked-inbox row hit targets + optimistic mark-read/unread.
- **CI adaptations:** fork canary publish opt-in, skip Cursor-only tests in fork release
  gate, `sync/**` branches exempt from the manual-lockfile-edit block.

## Syncing upstream

Deliberate, not routine. Merge `upstream/master` into a `sync/master-upstream-<date>`
branch, resolve conflicts (keep both sides), verify the guards above survived, open a PR
filling `.github/PULL_REQUEST_TEMPLATE.md`, then let Docker rebuild the deploy image.
