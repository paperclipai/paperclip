# IssueDetail test audit — 2026-10-12

Parent: #16088, `codex/test-audit-r16-heartbeat-recovery`, exact head
`a454638931ee8a2e40347aef1ab4fbf17d8acf9f`.

## Retained contracts

- The empty-subtask keeper retains the default task thread checks after the
  first flush, and default file-viewer/plan-query checks after the second.
  Its explicit empty list matches the shared beforeEach default.
- The first-task properties-button keeper uses the same first-task input.
  It now checks closePanel before the toggle, then still proves opt-in opening.
- Three repeated renders disappear: 140→137 cases, 109→106 declarations,
  +14/-57 test lines (43 fewer). All 17 parameterized declarations remain.
  The full ledger and AST proof remain in temporary receipts, not this PR.

## Exact-parent proof

| Full owner phase | Passed | Failed |
|---|---|---|
| Baseline | 140 | 0 |
| Candidate | 137 | 0 |
| Reverted test | 140 | 0 |
| Default thread forced to legacy | 108 | 29 |
| File viewer forced on | 136 | 1 |
| Plan panel forced to render/query | 136 | 1 |
| Panel close paths removed | 135 | 2 |
| Production restored, candidate | 137 | 0 |

Each production mutation fails its intended moved keeper assertion at lines
2463, 2470, 2473 or 4299. Each owner restoration is byte-for-byte. No cases
are skipped. `pnpm check:token-gates`, UI typecheck and diff-check pass.
The normal command from ui is `pnpm exec vitest run src/pages/IssueDetail.test.tsx`.

Parent test SHA-256: `06b026c4bd296848011d1cc30f89711453a9db0c1e4c743fa22ae653b3e942d7`.
Candidate SHA-256: `530b6046ce0c15ece4304bc49f711af6fc95ebd62ef5b0aa0515b96ce2d94995`.
Restored owner SHA-256: `17b28ad871c2f00fa2d1153d50f151ebd0bed68c85d5a0f2a50164a2f1a612b2`.
Receipts: `/private/tmp/test-audit-r17-issue-detail-replay/receipt.json`.
No production change is included. No CI speedup is claimed from local samples.
Full repository preflight stays in isolated CI because local dependency links
are shared; it would rewrite those links. CI must pass before green handoff.
