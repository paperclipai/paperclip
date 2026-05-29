# `codex-limit` operational label and the system-managed label family

Source of truth for the `codex-limit` operational label introduced by
[KSI-586](https://github.com/paperclipai/paperclip/issues) and the broader
distinction between **manual** and **system-managed** operational labels in
Paperclip.

This document is the canonical reference for adapter authors, tool integrators
and agent instruction maintainers. Per-agent `AGENTS.md` files SHOULD link here
instead of redefining the contract.

## Two families of operational labels

Paperclip uses operational labels at the issue level to communicate state that
an agent or a human needs to act on outside of normal in-progress execution.
Those labels split into two families with different lifecycle contracts:

| Family | Examples | Applied by | Removed by | Comment contract |
|---|---|---|---|---|
| **Manual** | `restart`, `rebuild`, `restart-rebuild`, `manual-terminal`, `approval-needed`, `blocked-external` | Human or agent | Human or agent (same heartbeat the condition resolves) | Comment with **owner**, **exact command (when applicable)** and **post-execution verification** |
| **System-managed** | `codex-limit` | Server (`server/src/services/issues.ts` helpers + heartbeat wiring) | Server (status transitions, reassign, probe routine) | Not required — the server lifecycle already encodes the contract |

A *manual* label describes an action a human or an agent must perform outside
of the container (rebuild, run a command, give an approval). A *system-managed*
label describes a state of waiting on an external system whose recovery is
detected and acted on by Paperclip itself.

The two families do not share the same checklist. Pre-`done`/`blocked`/
`in_review` checklists are written for the manual family; system-managed
labels are excluded from that checklist because the server, not the agent,
owns their lifecycle.

## `codex-limit`

### What it means

The `codex-limit` label is applied to an issue when its assigned agent runs on
the `codex_local` adapter and both Codex profiles (e.g. `CODEX_HOME` and
`CODEX_FALLBACK` configured via `codex-home-fallback`) report a usage-limit
error during a heartbeat. The server transitions the issue to `blocked`,
schedules a retry (`scheduled_retry` run), and applies the label so the board
can see at a glance that the issue is paused waiting for Codex credits to
return rather than for product work.

### Color and visual contract

- Name: `codex-limit`
- Color: `#06b6d4` (cyan-500), defined by the board in the KSI-586 plan
  decision (D2) as a distinct hue from the manual operational palette.
- Description: *Issue blocked waiting for Codex credit return (usage-limit).
  Applied and removed automatically by the server.*

The label is created idempotently by the server on first need. There is no
seed migration to run; the helper `ensureCodexLimitLabel(companyId)` in
`server/src/services/issues.ts` creates the row with the documented color the
first time the application path runs on a given company, and is a no-op on
later calls.

### Lifecycle

The label is applied automatically in `server/src/services/heartbeat.ts` on
the `scheduleBoundedRetryForRun` path when:

1. The agent's `adapterType === "codex_local"`.
2. The run reports `errorFamily: "transient_upstream"` with a Codex
   usage-limit signal (`hasUsageLimitSignal`, parsed in
   `packages/adapters/codex-local/src/server/parse.ts`).
3. The heartbeat outcome is `scheduled` (a `scheduled_retry` run was created).

Application is paired with:

- A status transition `in_progress → blocked` for the issue.
- A system comment naming the unblock owner (auto-resume by scheduled retry),
  the next attempt timestamp, and the affected profiles.

The label is removed automatically in symmetrical paths:

- **Retry promoted**: when `executeDueScheduledRetryRuns` promotes the
  `scheduled_retry` run, the issue returns to `in_progress` and the label is
  cleared.
- **Reassignment**: when an issue is reassigned to a different agent in
  `issueService.update()`, the label is cleared (caller-wins precedence: if
  the caller passes an explicit `labelIds`, the caller's intent is honoured).
- **Manual close**: when the issue is moved to `done` or `cancelled` outside
  the retry path, removal happens via the same `clearCodexLimitLabelIfApplicable`
  helper.
- **Probe recovery** (planned, [KSI-690](https://github.com/paperclipai/paperclip/issues)):
  when the `codex-limit-probe` routine detects a Codex profile recovery, it
  removes the label across all currently-blocked issues and accelerates their
  scheduled retries.

### Contract for agents and instruction maintainers

- Agents SHOULD NOT add or remove `codex-limit` manually. The server owns the
  lifecycle.
- Pre-disposition checklists ("before marking done/blocked/in_review verify
  every active operational label") apply only to the manual family. The
  presence of `codex-limit` does not imply a human action is pending; it
  implies the platform is waiting on an external system.
- If `codex-limit` is found on an issue with no active scheduled retry and no
  Codex usage-limit context (a stale state), an agent MAY clear it as part of
  state recovery, but MUST justify the removal in a comment.

## Adding new system-managed labels

Future system-managed labels (e.g. for other adapter quotas, model cool-downs,
or third-party rate limits) follow the same pattern:

1. Define the label name, color and description in `server/src/services/issues.ts`
   (or the equivalent module owning the lifecycle).
2. Implement an `ensure<Name>Label` + `add<Name>LabelToIssue` +
   `clear<Name>LabelIfApplicable` triplet that is idempotent inside or outside
   a transaction.
3. Wire application and removal into the deterministic server paths (heartbeat,
   reassignment, status transitions). Do not expose human/agent-driven
   application paths.
4. Document the label here and link from the relevant adapter or runtime doc.

The board MUST sign off on new system-managed labels before they are wired,
because they change the platform contract that agents read in their
instructions.

## References

- KSI-586 plan and decision documents on the ksio-dev Paperclip instance
  cover the original requirements, the D1–D5 board decisions and the subtask
  breakdown (A: blocked-during-retry; B: 1h backoff with D1-routing; C: this
  label; D: probe routine; E: integration tests).
- `server/src/services/issues.ts` — label helpers and reassignment hook.
- `server/src/services/heartbeat.ts` — application on `scheduleBoundedRetry`,
  removal on `executeDueScheduledRetryRuns`.
- `server/src/services/productivity-review.ts` — defensive suppression of the
  `long_active_duration` review trigger when `codex-limit` is present.
