# ART-368 audit pattern (2026-11-02)

Reference narrative for [`../SKILL.md`](../SKILL.md). Instance-local identifiers
are examples; the procedure generalizes to any GitHub CI diagnosis task.

## What happened

| Issue | Role | Disposition problem |
| --- | --- | --- |
| ART-331 | Parent — disposition repair handoff without code | Tracks systemic repair |
| ART-368 | Diagnosis — Paperclip PR checks #33/#34/#35, self-hosted runner logs | Marked `done` after correct read-only diagnosis |
| ART-370 | **Missing at close** — infra successor | Created later: repair localdev-light runners under ART-368 parent |

Audit finding: **diagnosis closed without a successor that had a human/infra owner**,
so infra work had no accredited queue. Secondary finding: **provider-error retry
timers** or narrated wakes ran **without task-bound** `executionPolicy.monitor` state.

## Correct sequence (repeatable)

1. Run Checklist B RED — capture failing checks at PR head SHA with `gh`.
2. Write root cause on the diagnosis issue (comment or document).
3. Run Checklist A — create successor with owner **before** diagnosis `done`.
4. Run Checklist C — confirm no fake monitor and no “handoff complete” without successor.
5. PATCH diagnosis `done` with successor id in the comment body.
6. Successor issue owns GREEN (runner repair, workflow fix, or operator action).

## Anti-patterns (do not repeat)

- `done` + “infra will pick this up” with no issue id.
- `in_review` + “please review CI” with no typed reviewer path or monitor timestamp.
- Disposition repair attempts exhausted while comments claim progress — see
  `disposition_repair_escalated` / `unchanged_source_state_exhausted` in
  `doc/execution-semantics.md` and `doc/SPEC-implementation.md` disposition repair bullets.

## Parent context

Keep diagnosis disposition skills aligned with ART-331 remediation: closing a
diagnosis must not simulate a code handoff when only an issue link and owner
change carry the work forward.
