## Done

Wake payload had 0 new comments and resumed a successful-run handoff for [TSMC-18735](/TSMC/issues/TSMC-18735), so I finished the route fix, reran the focused regressions, attached the evidence bundle, and closed the dispatch-integrity loop.

- Process checked: `docs/TSKB/README.txt`, `docs/TSMC-15910-fallback-lane-membership-repair-2026-07-09.md`, `/Users/glad0s/paperclip/skills/paperclip/SKILL.md`, `/Users/glad0s/paperclip/skills/fallback-lane-ops/SKILL.md`.
- Root cause: `server/src/routes/issues.ts` rewrote explicitly requested fallback sisters to their primaries inside `resolveActiveIssueAssigneeAgentReference(...)` whenever the primary was still invokable. That happened before persistence, so create/update could return 200 while storing the wrong lane.
- Fix shipped: removed sister->primary canonicalization from the route helper while keeping the paused-primary -> live-sister fallback path intact.
- Regression coverage added:
  - `server/src/__tests__/issue-assigned-backlog-contract-routes.test.ts`
  - `server/src/__tests__/issue-identifier-routes.test.ts`
- Verification:
  - `pnpm vitest server/src/__tests__/issue-assigned-backlog-contract-routes.test.ts server/src/__tests__/issue-identifier-routes.test.ts server/src/__tests__/issue-capability-routing.test.ts`
  - Passing quote: `Test Files  3 passed (3)` / `Tests  10 passed (10)`
- Live served-route evidence:
  - create proof on `TSMC-18741` stored `Auditor-Codex` exactly
  - patch proof on `TSMC-18743` recorded `issue.updated` from `Engineer-Codex` to `Auditor-Codex`, and the stored `issues.assignee_agent_id` row is `Auditor-Codex`
- Redirect-scope result:
  - TSMC families that would have redirected pre-fix: `Auditor -> Auditor-Codex`, `Auditor -> Auditor-Gemini`, `Engineer-Codex -> Engineer-Gemini`, `Engineer-Codex -> Engineer-Hermes`, `Ledger -> Ledger-Codex`, `Ledger -> Ledger-Gemini`
  - TSMC families that would not have redirected pre-fix because the primary was paused: `Astra -> *`, `GLaD0S -> *`
  - Second-company sample (`TSB`) also showed generic pre-fix exposure across active families; this was not an `Auditor-Codex` special case.
- Artifacts:
  - [TSMC-18735 evidence](/TSMC/issues/TSMC-18735)
  - [TSMC-18735 redirect scope table](/TSMC/issues/TSMC-18735)
- Canonical KB delta: `/Users/glad0s/TSKB/KB/TSKB0350 [PLATFORM] - Fallback sister assignee writes must not canonicalize to primary - v1.0 - 07-31.md`
- Recurrence mechanism and encoded layer:
  - mechanism: route-local sister-to-primary assignee canonicalization before issue persistence
  - encoded layer after fix: platform route guard plus route-level regression tests

Final disposition: `done`.
