# Explicit work-mode authority — 2026-09-22

## Contract

Task work mode is explicit persisted state. Asking for a plan in standard mode
is an ordinary deliverable request. Titles, descriptions, and document creation
never select planning mode. Explicit planning mode and revision-bound approval
remain supported.

The creation/update and runner mode paths already follow this contract. This
change removes the remaining legacy liveness title/description exemption and
feeds its diagnostic classifier the stored work mode from both heartbeat and
activity-ledger backfill. The prior disposition repair authority remains based
on persisted state. Other liveness prose diagnostics and progress accounting
remain separate follow-ups.

## Coverage matrix

| Layer | Cases |
|---|---|
| Classifier | Every old trigger word in title/description; missing, null, standard, ask, skill-test and planning modes; actual saved plan and completion in standard mode |
| Prompt/runner input | Neutral, planning-sounding and execution-sounding requests under standard, ask and planning; full/resumed task context; native execution-mode projection |
| Database service | Default mode at creation; title/body edits preserve mode; explicit updates change it; saved canonical plan preserves standard; ledger backfill reads persisted mode |
| Heartbeat | Standard/planning wording pairs preserve mode, repair allowance/instruction, wakes and final completion |
| Real-provider Product E2E | New paired plan deliverables on legacy/native; persisted mode, exact output, completion and no extra work/wait; existing explicit plan-revision/approval controls |

Use the existing isolated worktree and baseline inventory. Keep prior results
immutable. Run cheap checks first, then six relevant live cells in parallel
on GitHub Actions (four new standard-mode cells and the local legacy/native
`core-compatibility` explicit planning revision/approval controls). Record source SHA, selected cases, retained failed
attempts and final results before declaring verification complete.

## Verification

Deterministic baseline: 990/992 pass, with only the two previously recorded native
compatibility probes failing. All work-mode assertions pass; E2E support,
typechecks and build pass. Both explicit planning controls passed in campaign
35805477715; its four new wording cases exposed a Markdown/browser fixture
mismatch, with one additional duplicate model response. Those failures remain
recorded. After a fixture-only plain-text correction, both wording pairs passed
in campaign 35806360797 (4/4). See the
[measurement report](https://github.com/paperclipai/paperclip-evals/blob/ce3e5afcd4a1184650f586a2b5b8be5874c66c8b/experiments/2026-09-lifecycle-authority/EXPLICIT-WORK-MODE-2026-09-22.md).
The historical remaining-findings inventory is retained in
[the continuation plan](2026-09-22-legacy-continuation-authority.md).
