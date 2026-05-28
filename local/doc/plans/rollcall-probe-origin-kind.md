# Rollcall Probe Origin Kind

Status: Planned
Owner: Skills + Shared
Date: 2026-05-05
Target repo: fork `HenkDz/paperclip` (not submitted upstream)
Depends on: `feat/agent-declarable-origin-kind` (must be merged or rebased first)

## Summary

Register `rollcall_probe` as the first `AgentDeclarableOriginKind` and wire the
`agent-rollcall` skill to stamp all probe issues with it at creation time.

This builds directly on the generic mechanism introduced in the dependency branch.
Once that foundation exists, this change is minimal — one constant, one script flag,
and updated tests.

## Problem

Rollcall probe issues are short-lived ping tasks created by `agent-rollcall-probe.sh`.
They are intentionally transient:

- Assigned to a subordinate agent
- Expected to reach `done` within seconds to minutes
- If the subordinate is unresponsive, the rollcall result table records the failure
  and the probe should be silently cancelled — not escalated to the board

## The Rolecall Diagnostic

Unlike the passive "liveness sweeps" (which merely look for stalled work), a **Rolecall** 
is an active, end-to-end diagnostic mission. It stress-tests the entire Paperclip 
runtime by exercising:

1. **Orgchart Hierarchy:** Validates that the chain of command is reachable and 
   that parent-child agent relationships are functionally sound.
2. **Delegation Primitives:** Forces the use of `agent-delegate` and `agent-create-issue` 
   under a coordinated protocol.
3. **Saturation Activation:** Triggers a "thundering herd" of agent wakeups, 
   testing the system's ability to handle peak concurrency and adapter saturation.
4. **Semantic Readiness:** Confirms that each agent is not just "up," but capable 
   of comprehending and actioning a specific orchestration task.
5. **Full-Stack Integrity:** Every probe requires a working API, DB, adapter, 
   and skill-script execution for success.

Without an `originKind`, the recovery service treats them as ordinary stalled work and
may create `stranded_issue_recovery` child issues, wake manager agents, and post
escalation comments — all of which cost money, add latency, and obscure the real
rollcall results.

## Goals

1. All probe issues created by `agent-rollcall-probe.sh` carry `originKind: "rollcall_probe"`.
2. The recovery system (via the generic guards from the dependency branch) silently
   cancels unresponsive probes instead of escalating them.
3. Tests assert the `originKind` field is sent in the create-issue API call.

## Non-Goals

- Any changes to the rollcall protocol logic itself.
- Submitting `rollcall_probe` as a kind to upstream — it is fork-local.
- UI changes — `originKind` is an internal field.

## Design

### New origin kind constant

In `packages/shared/src/constants.ts`, extend `AGENT_DECLARABLE_ORIGIN_KINDS`:

```ts
export const AGENT_DECLARABLE_ORIGIN_KINDS = [
  "rollcall_probe",
] as const;
```

This automatically:
- Makes `"rollcall_probe"` valid in `createIssueSchema`
- Applies all three recovery guards from the dependency branch
- Excludes probe issues from liveness graph scanning

### Probe script change

`skills/agent-rollcall/scripts/agent-rollcall-probe.sh` — pass `--origin-kind rollcall_probe`
to the `agent-create-issue.sh` call.

That is the only behavioural change to the skill.

### Test update

`server/src/__tests__/agent-rollcall.test.ts` — add assertion on the logged
create-issue request:

```ts
expect(req.body.originKind).toBe("rollcall_probe");
```

## Implementation Steps

### Step 0 — Branch setup

```sh
# Must start from the dependency branch, not main
git checkout feat/agent-declarable-origin-kind
git pull
git checkout -b feat/rollcall-probe-origin-kind
```

> If `feat/agent-declarable-origin-kind` has not been merged to main yet, keep
> this branch rebased on top of it. Once the dependency merges upstream and is
> pulled into the fork, rebase this branch onto the updated main.

### Step 1 — Register the kind

- `packages/shared/src/constants.ts`
  - Add `"rollcall_probe"` to `AGENT_DECLARABLE_ORIGIN_KINDS`

### Step 2 — Wire the probe script

- `skills/agent-rollcall/scripts/agent-rollcall-probe.sh`
  - Add `--origin-kind rollcall_probe` to the `exec` call

### Step 3 — Update tests

- `server/src/__tests__/agent-rollcall.test.ts`
  - Update mock curl to pass `originKind` through in POST body
  - Add assertion: probe create request includes `originKind: "rollcall_probe"`

### Step 4 — Verification

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

### Step 5 — (When ready) Rebase onto merged main

Once `feat/agent-declarable-origin-kind` is merged upstream and pulled into the fork:

```sh
git fetch upstream
git rebase upstream/main
# resolve any conflicts (expect none — the dependency landed cleanly)
```

## Files Changed

| File | Change |
|---|---|
| `packages/shared/src/constants.ts` | Add `"rollcall_probe"` to `AGENT_DECLARABLE_ORIGIN_KINDS` |
| `skills/agent-rollcall/scripts/agent-rollcall-probe.sh` | Pass `--origin-kind rollcall_probe` |
| `server/src/__tests__/agent-rollcall.test.ts` | Assert `originKind` in probe create request |

## Risks

- If the dependency branch changes its constant name or shape, this branch needs a
  trivial rebase fix. Risk is low because the constant design is intentionally stable.
- If upstream rejects the generic PR and it never merges, this branch needs to either
  carry the full generic implementation inline or be deferred. In that case, collapse
  both branches into a single fork-only PR.

## Rebase / Collapse Policy

| Upstream decision | Action |
|---|---|
| Generic PR accepted, merged | Rebase this branch onto updated main, open fork PR |
| Generic PR accepted but delayed | Keep this branch stacked on the feature branch |
| Generic PR rejected | Collapse both branches into `feat/rollcall-probe-origin-kind`, carry full impl in fork |
