# Code-Writer Incidental Bug Triage Gate Design

Date: 2026-04-18
Status: Approved for implementation

## Goal

Enforce a default-on, instance-level policy that requires code-writing runs to explicitly record incidental bug triage before their issue work is treated as complete enough for handoff or recovery suppression.

## Problem

Today the system already requires issue-level truth comments such as `[BLOCKER]`, `[READY FOR QA]`, and `[QA PASS]`, and heartbeat recovery treats missing truth as stale or false-complete work. That solves "did the run say anything useful?" but it does not solve "did the run explicitly decide what to do about incidental bugs it noticed while touching code?"

If the repo policy becomes "always fix every incidental bug," the system will incentivize scope creep, unstable estimates, and drive-by fixes. If the policy stays instruction-only, many runs will simply omit the decision.

The missing contract is:

- code-writing runs must declare whether they saw incidental bugs
- the declaration must distinguish fix-now from defer/escalate
- the system must enforce the declaration without forcing every bug to be fixed inline

## Recommendation

Adopt a hybrid rule:

- hard gate on declaring the incidental-bug triage outcome
- soft rule on whether the incidental bug must be fixed immediately

This keeps accountability high without turning every issue into an uncontrolled cleanup sweep.

## Alternatives Considered

### 1. Instruction-only reminder

Rejected.

This is the cheapest implementation, but it will drift quickly because there is no consequence for omission. The repo already has evidence that instruction-only expectations are weaker than server-enforced workflow gates.

### 2. Mandatory fix-all policy

Rejected.

This directly creates scope creep and rewards opportunistic cleanup over focused delivery. It also encourages engineers to hide incidental bugs rather than surface them.

### 3. Hard declaration gate on run-linked issue truth

Chosen.

This reuses the existing heartbeat run comment policy, the issue truth model, and retry/recovery behavior. The run is not considered policy-satisfied until it publishes a compliant issue comment. That gives strong enforcement with bounded scope.

## Scope of Enforcement

V1 should enforce on issue-linked runs from code-writing adapters.

This is a pragmatic proxy for "touched code." The repo does not yet have a reliable, shared, cross-adapter signal for "this run definitely edited code files." Adapter type plus issue-linked run ownership is available now and is enforceable. Exact file-touch detection can be a later refinement.

The initial code-writing adapter allowlist should live in one helper and cover current built-in and first-party coding adapters:

- `claude_local`
- `codex_local`
- `cursor`
- `gemini_local`
- `hermes_local`
- `openclaw_gateway`
- `opencode_local`
- `pi_local`

Non-coding adapters such as `process` and `http` should remain out of scope.

## Required Declaration Format

The gate should require one explicit marker in the run-linked issue comment body:

```md
[INCIDENTAL BUG TRIAGE: NONE SEEN]
```

```md
[INCIDENTAL BUG TRIAGE: FIXED INLINE]
```

```md
[INCIDENTAL BUG TRIAGE: DEFERRED]
Reason: <short reason>
Follow-up: <issue id or note, optional but strongly preferred>
```

```md
[INCIDENTAL BUG TRIAGE: ESCALATED]
Reason: <short reason>
Escalation: <owner, issue id, or note>
```

Rules:

- `NONE SEEN` and `FIXED INLINE` need no extra fields
- `DEFERRED` and `ESCALATED` require a non-empty reason line
- the marker can appear anywhere in the issue comment body and can coexist with `[READY FOR QA]`, `[BLOCKER]`, or other existing truth markers

## Settings Shape

Add a new instance general setting:

- `requireIncidentalBugTriageForCodeWriters: boolean`

Behavior:

- default `true`
- editable only by instance-admin board users via Instance Settings
- stored alongside existing `general` JSON settings

This is not experimental. It is an operational workflow policy.

## Runtime Assistance

The hard gate should be paired with a runtime reminder so compliant comments are the default outcome.

For code-writing runs when the setting is enabled:

- prepend a short reminder to the effective run prompt in the heartbeat execution path
- for adapters that do not consume `promptTemplate`, inject the reminder through their adapter-specific wake/request text path before shipping V1 enforcement for that adapter
- do not mutate managed instructions bundles on disk
- do not require manual edits to agent instructions for enforcement to work

The reminder should tell the agent:

- if you touch code, your issue truth comment must include one incidental bug triage marker
- allowed outcomes are `NONE SEEN`, `FIXED INLINE`, `DEFERRED`, `ESCALATED`
- `DEFERRED` and `ESCALATED` must include a short reason

Adapters that already consume `promptTemplate` can inherit this centrally through the heartbeat execution config. Adapters that do not, such as `openclaw_gateway`, need an adapter-specific reminder path before they are included in the enforced allowlist; otherwise they would get a hard gate without a model-visible instruction path.

## Enforcement Flow

### 1. Run completes

The current behavior tries to find or synthesize a run-linked issue comment.

### 2. Comment policy evaluation runs

Replace the current binary "comment exists / comment missing" check with a policy evaluation:

- no issue linked: `not_applicable`
- comment missing: policy unsatisfied, reason `missing_issue_comment`
- comment present and triage not required: `satisfied`
- comment present, triage required, marker valid: `satisfied`
- comment present, triage required, marker missing or invalid: policy unsatisfied, reason `missing_incidental_bug_triage`

The policy result should preserve both:

- coarse publication status (`satisfied`, `retry_queued`, `retry_exhausted`, etc.)
- specific policy reason (`missing_issue_comment` vs `missing_incidental_bug_triage`)

The existing coarse status alone is not enough for operator debugging or UI messaging because both failure modes would otherwise collapse into the same `retry_queued` / `retry_exhausted` states.

### 3. Retry path

If the reason is `missing_incidental_bug_triage`, queue the same one-time retry behavior currently used for missing comments, but with the new retry reason in wake payload/context.

### 4. Recovery path

If the retry also fails, publish a recovery notice that clearly says the run ended without a compliant incidental-bug triage declaration, not just "without publishing an issue comment."

### 5. Recovery scoring

Extend the stale/false-complete heuristics so a code-writing run with handoff/completion truth but without the required triage declaration is treated as false-complete assigned work.

## Parsing and Validation

Introduce a small dedicated parser/helper for incidental bug triage markers instead of embedding more regex logic directly into `heartbeat.ts`.

The helper should:

- parse the four allowed outcomes from freeform markdown
- ignore fenced code blocks, matching the existing truth classifier behavior
- ignore quoted prior-comment or transcript blocks so pasted history does not accidentally satisfy the policy
- require reason lines only for `DEFERRED` and `ESCALATED`
- return a normalized outcome object or `null`

This keeps the policy testable without growing `heartbeat.ts` further.

## Operator Surface

V1 does not need a brand-new UI workflow.

Minimum operator-visible changes:

- Instance Settings > General toggle with default-on copy
- recovery comments and run events use the specific missing-triage language
- issue detail can continue showing the existing comment publication status values (`published`, `retry queued`, `retry exhausted`)

If later needed, a follow-up can add a dedicated reason code to the UI.

## Documentation Impact

Implementation must update:

- `doc/SPEC-implementation.md` to describe the policy and default-on setting
- agent-facing instructions or baseline docs to explain the required marker format for code-writing runs

## Risks

### False positives on non-editing coding runs

Because V1 uses code-writing adapter type as the proxy, some runs that inspect code but do not edit it will still need a `NONE SEEN` declaration. This is acceptable for the first version because it is explicit, cheap, and enforceable.

### External adapter drift

If new coding adapters are added and the allowlist is not updated, they will miss enforcement. The helper must be centralized and documented so new adapter work updates it intentionally.

### Recovery message ambiguity

If missing-comment and missing-triage failures share the same wording, operators will misdiagnose the problem. Recovery notices and retry reasons need to distinguish them clearly.

### Adapter-specific reminder gaps

If an enforced adapter does not consume `promptTemplate` or managed instructions content, a central heartbeat prompt prepend will not reach the model. V1 must either add an adapter-specific reminder path or exclude that adapter from enforcement until one exists.
