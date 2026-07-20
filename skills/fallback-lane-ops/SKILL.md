---
name: fallback-lane-ops
description: Operate model-fallback "sister" lanes when a primary agent is unavailable. Use when a primary agent hits Claude session/weekly/usage limits, an adapter returns auth or quota errors, a sister agent is in an error state, or the task asks for a takeover, swap-back, controlled ramp, or adapterConfig/model repair on a fallback lane. Covers detection signatures, the takeover and swap-back protocols, ramp rules for recovering lanes, and the registry and state-file schemas that make swap-back possible.
---

# Fallback Lane Ops

Primary agents run on one adapter (usually `claude_local`). When that adapter is rate-limited or down, work moves to pre-hired "sister" agents on other adapters, then moves back after the reset window. Everything here is registry-driven and auditable — issue comments are the audit trail for every live move.

## Detection signatures

- **Usage limits** in run logs: `You've hit your (session|weekly|daily|5-hour|usage) limit`, with a reset time parsed from "Your limit will reset at <ISO>" or "try again at <clock time>". When no reset time is parseable, assume: session/usage → 6 h, weekly → 7 days.
- **Adapter auth/model errors**: e.g. Codex CLI under ChatGPT auth rejecting `*-codex` model variants and plain `gpt-5.3` with `400 invalid_request_error: "<model> model is not supported when using Codex with a ChatGPT account"` — a config problem, not a quota problem (see Model repair below).
- **Sister in error state**: paused, disabled, archived, suspended, error, or ramp-blocked. Fallback tooling skips these as targets by default.

## Registry and state schemas

- **Fallback registry** (`fallback-registry*.json` in the operating agent's instructions dir): `{ "<primaryAgentId>": ["<firstChoiceSisterId>", "<secondChoiceSisterId>", ...] }`. Legacy single-string values are still accepted. Adapter family priority when deriving chains from company inventory: `claude_local -> codex_local -> grok_local -> hermes_local`. Explicit registry entries win; safe inventory-derived same-lane targets are appended.
- **Per-primary state file** (written on takeover, consumed by swap-back): `~/.paperclip/instances/default/companies/<companyId>/fallback-state/<primaryId>.json`, recording `sisterAgentIds`, per-issue `movedIssueTargets`, and the limit `resetAt`. The session-limit watcher keeps its own state under `~/.paperclip/session-limit-watch-state/<companyId>/session-limit-watch/<primaryAgentId>.json`.
- Some companies also keep a human-readable `fallback-registry/registry.json` with `fallbacks[]` entries (`primaryAgentId`, `sisterAgentId`, adapter types, `triggerCondition`, `status`, source issues). Keep both in sync when you add a lane.

## Takeover protocol (primary limited → sister)

Automated path: the `fallback-monitor` routine (every 15 min, deliberately run on a non-Claude adapter so it survives the outage it mitigates) scans recent heartbeat-run logs for limit signatures on registered primaries, then for each hit:

1. Skips paused/disabled sisters; tries remaining sisters in registry priority order.
2. When `FEATURE_FALLBACK_REASSIGN=on`, the chosen sister must **self**-take over each issue through `POST /api/issues/:issueId/fallback-reassign` instead of a manual assignee patch. That route enforces the registered-sister check, writes the audit comment, releases the old checkout, and wakes the sister. If the issue is already on the sister, it returns `200` with `noop: true`.
   - Self-takeover is the only route. Calling on the sister's behalf from a monitor or operator lane is rejected with `403` / `details.reason = "third_party_target"` — the target agent must be the authenticated caller. There is no delegated-executor grant that lifts this. A monitor routine running on some other lane can select and wake the sister, but the reassign call itself has to come from the sister's own run.
   - A stranded issue that recovery rebound away from the failed primary is still takeable: when the live assignee owns an active recovery action, the route resolves the real primary from that action's previous/return owner and requires a live unrevoked fallback relationship from *that* primary to the calling sister. Send `expectedFromAgentId` as the failed primary, not the recovery owner. On success the route also resolves the recovery action (outcome `delegated`), so do not close it by hand afterwards.
   - A `409` mismatch means your view of the primary is stale; its `details` carry the effective primary (`actualAssigneeAgentId`), the live assignee (`currentAssigneeAgentId`), and the recovery owner — re-derive from those rather than re-reading the issue. An issue in another company answers `404`, identical to a missing one.
3. Reassigns only issues whose primary is fallback-eligible and **skips any issue with an active queued/running run**.
4. Leaves a handover comment on every moved issue and writes the per-primary state file.
5. Patches its own execution issue to `done` with a summary.

### Pre-dispatch health gate for long creative jobs

Before you launch or re-launch a long creative job on its primary lane (video generation, large renders, bulk asset generation, long Codex sessions, or any run that is expensive to restart), do a fast health-gate check against that lane's most recent runs:

1. Look back at the recent run window for the target lane.
2. If you see a repeated burst of `claude_transient_upstream`, `codex_transient_upstream`, or `adapter_failed` on that same lane, treat the lane as temporarily unhealthy for long jobs even if it is not yet hard-paused.
3. Do not feed the long job into the unhealthy lane just because the queue is clear. Prefer the registered sister lane first, or defer launch until the reset / repair window if no safe sister exists.
4. Leave an audit comment or handoff note that names the burst evidence and says the job was health-gated before launch.

Operational rule: the health gate is for avoiding fail-plus-cancel churn on expensive work, not for every tiny issue. Use it when the cost of a bad launch is materially higher than the cost of a sister-lane handoff or a short delay.

Manual operator path (`scripts/session-limit-watch.py`) is the fallback only when the route is disabled, the lane is not registry-wired yet, or you are doing recovery/backfill around the normal self-healing path. Always escalate force in this order, never start broad:

1. Dry run: `--simulate-limit <primaryId> --simulate-reset-minutes 60 --max-issues 2` (expects JSON with `apply: false`, candidates under `moved`/`movedIssueTargets`; mutates nothing).
2. One-issue apply: add `--max-issues 1 --apply --yes`; verify the issue moved and got a handover comment.
3. Swap the test issue back (`--swap-back <primaryId> --max-issues 1 --apply --yes --force`) to prove the restore path.
4. Only then uncapped (`--max-issues 0`) or `--watch --interval-seconds 60` continuous mode.
5. `--reassign-all <primaryId>` drains a queue without a fresh limit event — dry-run first, respect the duplicate-storm preflight (10+ repeated title/body matches blocks apply; inspect with the duplicate-issue sweep, never cancel duplicates from the reassign path). Default apply skips `in_progress`/`in_review`/active runs; `--force` moves those too and leaves force evidence.

When the pre-dispatch health gate trips, treat it like a narrow manual takeover: dry-run the move first, prove one issue on the sister lane, then expand. Do not bulk-drain long creative work onto an unhealthy lane and hope the next retry sticks.

Context handoff: run `fallback-brief.py <issue>` for a low-token restart packet (identity, parent chain, scope snapshot, latest comments, suggested next action); paste key bullets plus one explicit next atomic action for the receiving sister. `--issue-comment --post-comment` posts it directly.

## Swap-back (after the reset window)

The `fallback-swap-back` routine reads the per-primary state files and, once `resetAt` has passed, reassigns the moved issues from the sister back to the primary (again skipping issues with active runs), then closes its execution issue with a summary. Manual equivalent: `session-limit-watch.py --swap-back <primaryId> --max-issues 0 --apply --yes --force`. Verify assignment landed back on the primary before closing anything.

## Ramp rules (recovering or newly-trusted lane)

A lane returning from an error state runs in **controlled ramp**:

- Cap at 3 or fewer live-capacity issues (`in_progress` + actively-reviewed `in_review`; parked `todo`/`backlog`/`blocked` count 0) until it completes **3 consecutive non-smoke backlog issues cleanly** — no repeated comments, no recursive child creation, no wrong-target work, no stale pause/continuation behavior, no adapter/session failure.
- Assign one bounded issue at a time; no batch, recursive, or routine fan-out during ramp.
- Any ramp failure: stop new assignments, route containment to the active fallback CTO lane, and pause the agent if the live adapter is unsafe.
- Fallback tooling must not auto-target ramp-blocked or sensitive lanes unless the operator explicitly passes the allow flags for that company/lane.

## Model / adapterConfig repair

- `model-switch.py show|list|set <preset|model-id>` edits the Codex config (`--config`, `$CODEX_CONFIG_PATH`, `$CODEX_HOME/config.toml`, `~/.codex/config.toml`, in that order); every `set` writes a timestamped backup.
- Verified-working presets under ChatGPT auth: `codex-default`/`general-default` → `gpt-5.5`, `codex-fast` → `gpt-5.4`. Do NOT reintroduce a `-codex` model preset while ChatGPT auth is active — it breaks every `codex_local` sister heartbeat.
- After a switch, post the handoff note: timestamp, from-model, to-model, reason.

## Escalation

- Adapter quota/session/model/profile failures → the fallback CTO lane first, unless the failing agent IS the CTO lane.
- Unblocks needing agent creation, permission grants, or board action → the active CEO lane.
- Guardrails: never edit the database directly; never store broad tokens in files or comments; keep dry-run mode until one-issue apply and swap-back have both passed.

To hire a new sister lane, see [references/sister-lane-hiring.md](references/sister-lane-hiring.md).
