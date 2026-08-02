# TSMC-18735 evidence

## Root cause

`server/src/routes/issues.ts` had route-local assignee normalization in `resolveActiveIssueAssigneeAgentReference(...)` that rewrote any explicitly requested fallback sister to its primary whenever the primary was still invokable. That happened before the issue service saw the request, so create and patch both returned 200 while silently storing the primary.

Removed behavior:
- `getFallbackPrimaryRelationshipForSister(companyId, assignee.id)`
- if primary status was invokable, `return primary.id`

That logic was generic, not `Auditor-Codex`-specific.

## Automated regression proof

Command:

```bash
pnpm vitest server/src/__tests__/issue-assigned-backlog-contract-routes.test.ts \
  server/src/__tests__/issue-identifier-routes.test.ts \
  server/src/__tests__/issue-capability-routing.test.ts
```

Passing output:

```text
Test Files  3 passed (3)
Tests  10 passed (10)
```

Coverage added:
- mocked route contract: direct create to a fallback sister stays exact
- embedded Postgres route test: create + patch both store the exact requested sister assignee
- existing capability-routing test still passes

## Live served-route verification (TSMC)

Directly verified on Friday, July 31, 2026:

| Check | Issue | Request | Stored assignee | Result |
|---|---|---|---|---|
| POST create | `TSMC-18741` | `assigneeAgentId=Auditor-Codex` | `Auditor-Codex` | exact |
| PATCH update | `TSMC-18743` | `assigneeAgentId=Auditor-Codex` | `Auditor-Codex` | exact |

Patch proof was confirmed by:
- the PATCH response payload for `TSMC-18743`
- the stored `issues.assignee_agent_id` row in Postgres
- the `issue.updated` activity-log entry showing `_previous.assigneeAgentId=Engineer-Codex` and `assigneeAgentId=Auditor-Codex`

Note: patching live work item `TSMC-18731` from this lane is correctly rejected with `Issue is outside this actor's authorization boundary`, so I used a fresh issue I owned for the served PATCH proof.

## Redirect scope table

### Directly verified

- TSMC live served route: `Auditor-Codex` no longer redirects on create or patch.
- Embedded Postgres route test (separate company fixture): a primary/sister family outside TSMC also no longer redirects on create or patch.

### Inference from live registry state plus the removed pre-fix rule

Source artifact: `work-products/TSMC-18735/redirect-scope.tsv`

Rule applied: under the removed logic, any requested sister with an invokable primary (`active`, `idle`, or `running`) would be rewritten to that primary. If the primary was `paused`, no sister->primary rewrite happened.

#### TSMC families

| Primary | Sister | Primary status on 2026-07-31 | Pre-fix result |
|---|---|---:|---|
| Astra | Astra-Codex | paused | would not redirect |
| Astra | Astra-Hermes | paused | would not redirect |
| Astra | Astra-Gemini | paused | would not redirect |
| Auditor | Auditor-Codex | running | would redirect |
| Auditor | Auditor-Gemini | running | would redirect |
| Engineer-Codex | Engineer-Gemini | running | would redirect |
| Engineer-Codex | Engineer-Hermes | running | would redirect |
| GLaD0S | GLaD0S-Hermes | paused | would not redirect |
| GLaD0S | GLaD0S-Gemini | paused | would not redirect |
| Ledger | Ledger-Codex | idle | would redirect |
| Ledger | Ledger-Gemini | idle | would redirect |

#### Second company sample: ThinkStack Books (TSB)

Every active family sampled from live `agent_fallback_sisters` rows would have redirected pre-fix because the lane primary was invokable at check time, including:
- `Architect -> Architect-Codex`
- `Author -> Author-Codex`
- `Author -> Author-Gemini`
- `Designer -> Designer-Codex`
- `Designer -> Designer-Gemini`
- `Editor -> Editor-Codex`
- `Editor -> Editor-Gemini`
- `Forge -> Forge-Codex`
- `Forge -> Forge-Hermes`
- `Press -> Press-Hermes`
- `Quill -> Quill-Codex`
- `Quill -> Quill-Gemini`
- `Researcher -> Researcher-Codex`
- `TSB Compiler -> TSB Compiler-Hermes`

That shows the defect was route-generic, not a one-off `Auditor-Codex` special case.

## Recurrence mechanism

- Recurrence mechanism: route-local sister-to-primary assignee canonicalization before issue create/update persistence.
- Encoded layer after fix: platform guard in `server/src/routes/issues.ts` plus route-level regression tests in `server/src/__tests__/issue-assigned-backlog-contract-routes.test.ts` and `server/src/__tests__/issue-identifier-routes.test.ts`.
