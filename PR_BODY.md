## Thinking Path

> - Paperclip runs AI agents whose intelligence comes from a subscription/provider adapter (e.g. `claude_local`).
> - When that source hits a provider quota / rate limit, a run fails with `errorCode: "provider_quota"` and recovery reschedules the retry to wait out the reset window (up to an hour).
> - Operators who hold more than one subscription would rather have the agent switch to a second subscription immediately than idle until the window clears — like a fallback provider chain.
> - There was no way to express "if source A is exhausted, use source B": model profiles override config but can't switch auth, and no fallback-chain scaffolding exists on master.
> - This pull request adds a per-agent `runtime_config.fallbackChain` and fails a quota-exhausted run over to the next **same-provider** source (a second Claude subscription — same adapter, different token) immediately instead of waiting.
> - The benefit is continuity: agents keep working across a quota wall by rolling to the operator's next subscription, with no idle window.

## Issue (described in-PR, Enhancement)

_No public GitHub issue existed; describing it inline per CONTRIBUTING.md, following the Enhancement template._

- **Existing behavior improved:** provider-quota recovery for a run (`heartbeat.ts` transient-continuation reschedule and the provider-quota wait monitor in `recovery/service.ts`).
- **Subsystem affected:** server / heartbeat run scheduling + recovery.
- **Current behavior:** a `provider_quota` failure reschedules the same source at the reset time; the agent idles until then, even if the operator has a second subscription that could serve the run now.
- **Proposed behavior:** an agent may configure `runtime_config.fallbackChain` — ordered alternate sources. On a `provider_quota` failure, if the next source is same-provider (same `adapterType`, a different auth token), the retry is scheduled **immediately** with that source, and the executor authenticates against it.
- **Reason and benefit:** keeps agents working across a quota wall by rolling to the next subscription instead of idling.
- **Breaking changes:** none. Additive `runtime_config` field; no-op for agents without a `fallbackChain`.

## Duplicate / related PR search

Searched before starting. No merged fallback-chain exists; the prior attempts are stale/closed and this does not overlap them:
- #2153 (closed, unmerged) — a simpler claude↔codex adapter failover.
- #3497 (open, last updated Apr 2026) — per-agent failover model chains; abandoned.
- #2946 (open) — a larger unified gateway-routing layer.

## What Changed

- **Schema:** `runtime_config.fallbackChain` — an ordered, `.max(4)` array of `{ adapterType, model?, effort?, env?, label? }` sources, added to `agentRuntimeConfigSchema` (reuses `agentAdapterTypeSchema` / `envConfigSchema`).
- **Pure logic** (`server/src/services/intelligence-fallback.ts`): the exhaustion predicate (`provider_quota` only; never budget caps or real failures), chain reader, next-source selector, run-context override codec, and the same-adapter config overlay.
- **Trigger:** on a `provider_quota` reschedule (both the transient-continuation path in `heartbeat.ts` and `ensureProviderQuotaWaitRecoveryMonitor` in `recovery/service.ts`), if an untried same-adapter fallback exists, schedule the retry at `now` with the source stamped on its context.
- **Consume:** `executeRun` overlays the stamped source's `env`/`model`/`effort` before secret resolution, so the retry authenticates against the fallback subscription's token.
- **Scope:** cross-provider sources (a different `adapterType`, e.g. Codex) are validated and stored but not switched yet — a deliberate follow-up, since switching adapters reworks session handling.

## Verification

- `pnpm --filter @paperclipai/server exec vitest run src/__tests__/intelligence-fallback.test.ts` — 13 unit tests for the pure logic (trigger predicate, selection, overlay, override codec).
- `pnpm --filter @paperclipai/server exec vitest run src/__tests__/heartbeat-retry-scheduling.test.ts` — includes a new end-to-end test: a `provider_quota` run with a same-provider `fallbackChain` reschedules **immediately** (not the fake adapter's 2030 reset) with the fallback source stamped on the retry context. Existing quota-retry tests unchanged (30 → 31 passing).
- Recovery suites (`src/services/recovery/`) green.

## Risks

- Low. No-op for agents without a `fallbackChain`; the trigger fires only on `provider_quota` (never budget exhaustion or real failures). The chain is capped at 4, so a misconfiguration cannot fan a stranded run into an unbounded retry storm. Cross-provider switching is intentionally deferred, so no session-handling paths change.

## Model Used

- Claude Opus 4.8 (Anthropic), extended thinking, via Claude Code with tool use / code execution.

## Checklist

- [x] I have included a thinking path that traces from project context to this change
- [x] I have specified the model used (with version and capability details)
- [x] I have checked ROADMAP.md and confirmed this PR does not duplicate planned core work
- [x] I have searched GitHub for duplicate or related PRs and linked them above
- [x] I have either (a) linked existing issues with `Fixes: #` / `Closes #` / `Refs #` OR (b) described the issue in-PR following the relevant issue template
- [x] I have not referenced internal/instance-local Paperclip issues or links (only public GitHub `#NNN` / `github.com/paperclipai/paperclip` URLs)
- [x] My branch name describes the change (e.g. `docs/...`, `fix/...`) and contains no internal Paperclip ticket id or instance-derived details
- [x] I have run tests locally and they pass
- [x] I have added or updated tests where applicable
- [x] I have considered documentation and no user-facing docs are affected by this internal scheduling change
- [x] I have considered and documented any risks above
- [ ] All Paperclip CI gates are green
- [ ] Greptile is 5/5 with no open P2s, recommendations, or follow-ups
- [x] I will address all Greptile and reviewer comments before requesting merge

---

A focused first increment of an intelligence fallback chain (fail a quota-exhausted run over to a second Claude subscription immediately). Cross-provider (Codex) failover is a planned follow-up.
