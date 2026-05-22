# Agent-Declarable Origin Kind

Status: Planned
Owner: Server + Shared + Skills
Date: 2026-05-05
Target repo: upstream `paperclipai/paperclip`

## Summary

Allow agents to self-declare a restricted set of `originKind` values when creating
issues via the API. The primary motivation is suppressing automatic recovery workflows
for short-lived orchestration issues (health probes, scheduled pings, or diagnostic "heartbeats") that
are intentionally transient and should never trigger stranded-issue recovery or liveness
escalation.

Beyond suppression, this establishes `originKind` as a **Coordination Protocol**. 
By allowing agents to tag issues with specific intents or skill-affinities (e.g., 
`skill:deployment`), we enable more deterministic routing, specialized monitoring 
logic, and more efficient agent-to-agent handoffs.

This is especially critical for **Active Orchestration Diagnostics**. 
Unlike passive system sweeps, these missions (like a "Rolecall" or "Saturation Test") 
proactively exercise the entire runtime — orgchart hierarchy, delegation flow, 
and adapter capacity — without triggering noisy system recovery alerts.

## Problem

The recovery service runs two periodic sweeps:

1. **`reconcileStrandedAssignedIssues`** — fires when a `todo`/`in_progress` issue has
   no active execution path for too long. Creates a `stranded_issue_recovery` child
   issue and wakes a manager agent.

2. **`collectIssueGraphLivenessFindings`** — graph-liveness sweep. Currently only
   excludes `issueGraphLivenessEscalation` issues from its scan.

Orchestration patterns (rolecalls, health probes, ping tasks) create short-lived issues
that:
- Are intentionally assigned and expected to complete quickly
- Should be silently cancelled, not escalated, if they fail or time out
- Should never spawn nested recovery work
- Add cost and latency noise when recovery fires on them

There is no public API mechanism to opt an issue out of this behaviour today.
`originKind` is the right signal (it already governs recovery routing for
`strandedIssueRecovery` and `issueGraphLivenessEscalation`) but it is not exposed in
`createIssueSchema`.

## Goals

1. Let agents set a safe subset of `originKind` values at issue-creation time.
2. Add recovery guards for those kinds so they:
   - do not spawn nested stranded-issue recovery
   - are silently cancelled (not escalated) if they fail
   - are excluded from the liveness graph sweep
3. Keep the guard clean and extensible — adding a new safe kind requires only one
   constant change.
4. Do not allow agents to self-declare system-owned kinds
   (`stranded_issue_recovery`, `issueGraphLivenessEscalation`, etc.).
5. Support **Intent-Routing**: Lay the groundwork for using `originKind` as a 
   signal for deterministic task assignment and skill-affinity.

## Non-Goals

- Implement specific production kinds (like `health_check`) in this foundational PR.
  The allowlist starts empty to define the mechanism; specific additions can follow
  in the same or subsequent commits.
- Changing how existing `strandedIssueRecovery` or `issueGraphLivenessEscalation`
  issues are created or routed.
- Exposing `originId` or `originFingerprint` to the public API.
- UI changes — origin kind is an internal field not shown in issue detail.

## Design

### Agent-safe origin kinds allowlist

Add a new constant in `packages/shared/src/constants.ts`:

export const AGENT_DECLARABLE_ORIGIN_KINDS = ["health_check"] as const;
export type AgentDeclarableOriginKind = (typeof AGENT_DECLARABLE_ORIGIN_KINDS)[number];

export type PluginIssueOriginKind = `plugin:${string}`;
export type SkillIssueOriginKind = `skill:${string}`;
export type IntentIssueOriginKind = `intent:${string}`;

export type IssueOriginKind =
  | BuiltInIssueOriginKind
  | PluginIssueOriginKind
  | SkillIssueOriginKind
  | IntentIssueOriginKind;
```

Initially, the static allowlist will contain `health_check` as a generic example.
The types for `skill:`, `intent:`, and `plugin:` formalize the coordination protocol.

`ISSUE_ORIGIN_KINDS` (used for documentation/type completeness) is extended to include
any new kinds added to this list.

### Public API validator change

In `packages/shared/src/validators/issue.ts`, update `createIssueSchema` to allow
the new kinds via a refinement:

```ts
originKind: z
  .string()
  .refine(
    (val) => {
      if (AGENT_DECLARABLE_ORIGIN_KINDS.includes(val as any)) return true;
      if (val.startsWith("skill:")) return true;
      if (val.startsWith("intent:")) return true;
      if (val.startsWith("plugin:")) return true;
      return false;
    },
    { message: "Invalid declarable originKind. Must be one of AGENT_DECLARABLE_ORIGIN_KINDS or start with 'skill:', 'intent:', or 'plugin:'." }
  )
  .optional()
  .nullable(),
```

When the enum is empty the field is still accepted as absent/null — no validator error.
As kinds are added they become valid options.

### Recovery service guards (3 locations)

**`server/src/services/recovery/service.ts`**

1. `ensureStrandedIssueRecoveryIssue` — add guard at top:
   ```ts
   if (isAgentDeclarableOriginKind(input.issue.originKind)) return null;
   ```
   Prevents probe issues from spawning a `stranded_issue_recovery` child.

2. `escalateStrandedAssignedIssue` — add branch before escalation:
   ```ts
   if (isAgentDeclarableOriginKind(input.issue.originKind)) {
     // silently cancel — no escalation, no comment, no recovery child
     await issuesSvc.update(input.issue.id, { status: "cancelled" });
     return null;
   }
   ```
   Probe failures are expected; escalating to the board is noise.

3. `collectIssueGraphLivenessFindings` — add to the `notInArray` exclusion list
   in both the `issueRows` and `activeIssueRunRows` queries:
   ```ts
   notInArray(issues.originKind, [
     RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
     ...AGENT_DECLARABLE_ORIGIN_KINDS,
   ]),
   ```

### Helper function

Add to `server/src/services/recovery/origins.ts`:

```ts
export function isAgentDeclarableOriginKind(originKind: string | null | undefined) {
  if (!originKind) return false;
  if (AGENT_DECLARABLE_ORIGIN_KINDS.includes(originKind as any)) return true;
  return (
    originKind.startsWith("skill:") ||
    originKind.startsWith("intent:") ||
    originKind.startsWith("plugin:")
  );
}
```

### Skill script change

`skills/agent-delegate/scripts/agent-create-issue.sh` — accept an optional
`--origin-kind <value>` flag and include it in the JSON payload when present.

## Implementation Steps

### Step 0 — Branch setup

```sh
git checkout main
git pull
git checkout -b feat/agent-declarable-origin-kind
```

No dependency on any other branch.

### Step 1 — Shared constants

- `packages/shared/src/constants.ts`
  - Add `AGENT_DECLARABLE_ORIGIN_KINDS` (empty array to start)
  - Add `AgentDeclarableOriginKind` type
- `packages/shared/src/index.ts`
  - Export both

### Step 2 — Shared validator

- `packages/shared/src/validators/issue.ts`
  - Add `originKind` to `createIssueSchema`

### Step 3 — Recovery helper

- `packages/shared/src/constants.ts` — export new constant
- `server/src/services/recovery/origins.ts`
  - Add `isAgentDeclarableOriginKind` function

### Step 4 — Recovery service guards

- `server/src/services/recovery/service.ts`
  - Guard 1: `ensureStrandedIssueRecoveryIssue`
  - Guard 2: `escalateStrandedAssignedIssue`
  - Guard 3: `collectIssueGraphLivenessFindings` (both query sites)

### Step 5 — Skill script

- `skills/agent-delegate/scripts/agent-create-issue.sh`
  - Add `--origin-kind` flag

### Step 6 — Tests

- `server/src/__tests__/recovery-origin-kind.test.ts` (new)
  - Unit: `isAgentDeclarableOriginKind` returns false for system kinds
  - Unit: `isAgentDeclarableOriginKind` returns true for any listed kind
  - Integration (mock DB): stranded assigned issue with declarable origin kind is
    silently cancelled, not escalated
  - Integration: liveness findings query excludes issues with declarable origin kinds

### Step 7 — Verification

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

### Step 8 — PR to upstream

Follow `.github/PULL_REQUEST_TEMPLATE.md`. PR title:
`feat: allow agents to declare a safe origin kind on issue creation`

## Files Changed

| File | Change |
|---|---|
| `packages/shared/src/constants.ts` | Add `AGENT_DECLARABLE_ORIGIN_KINDS`, `AgentDeclarableOriginKind` |
| `packages/shared/src/index.ts` | Export new constant and type |
| `packages/shared/src/validators/issue.ts` | Add `originKind` to `createIssueSchema` |
| `server/src/services/recovery/origins.ts` | Add `isAgentDeclarableOriginKind` |
| `server/src/services/recovery/service.ts` | 3 recovery guards |
| `skills/agent-delegate/scripts/agent-create-issue.sh` | `--origin-kind` flag |
| `server/src/__tests__/recovery-origin-kind.test.ts` | New test file |

## Risks

- If `AGENT_DECLARABLE_ORIGIN_KINDS` is accidentally populated with a system kind,
  recovery would be suppressed for real production issues. Mitigated by: keeping
  system kinds in a separate constant, and adding a test that asserts system kinds
  are NOT in the declarable list.
- Silent cancellation of stranded probe issues could mask a real adapter problem
  where agents are consistently failing to pick up their probes. Mitigated by:
  orchestration patterns that use declarable origin kinds are expected to record
  outcomes themselves (e.g. in a parent issue comment) — silent cancellation is
  appropriate precisely because the caller owns the result surface.

## Open Questions

1. Should silently-cancelled declarable-kind issues log an activity entry?
   Recommendation: yes, with `source: "recovery.silent_cancel_declarable_origin"` so
   operators can audit without board noise.

2. Should `AGENT_DECLARABLE_ORIGIN_KINDS` live in `constants.ts` or a new
   `recovery-origins` shared module?
   Recommendation: `constants.ts` for now — it's a small list and co-locates with
   `ISSUE_ORIGIN_KINDS`.
