# Sprint Report Protocol

Canonical sources: TSKB0149, TSKB0150, and TSKB0160. Treat those TSKB entries as the source of truth; this skill is only the operational checklist.

## Resolve The Latest Source

When a daily-summary or MC intake needs the current sprint-report handoff:

1. Find the newest relevant `CEO sprint report + morning plan` routine-execution issue for the company and cadence window.
2. Read that issue's comments and pick the newest comment containing `SPRINT-REPORT CONFIRMED <COMPANY> <date>`.
3. Ignore cancelled/superseded issues, stale "latest accepted source" memory, old review anchors, and full-text `q=` search results when newer confirmed routine fires exist.
4. Cite the exact issue identifier and comment date in the summary, blocker note, or closeout.
5. If no current confirmed marker exists, report the resolver failure explicitly; do not invent a missing-generation incident until the latest routine fire has been checked.

## File The Routine Report

For routine CEO sprint-report or daily handoff issues:

1. Save the report artifact and matching issue document when required.
2. Write the close reasoning on-thread yourself.
3. Close `done` when the report is truthful and no real operator decision remains.
4. Do not create `request_confirmation` or park `in_review` just so the board can acknowledge a routine report.

Use `in_review` only for an actual decision gate such as spend, credential/OAuth, visual QA, or another operator-only choice.

## Handle Daily Deltas

For the C-suite daily-delta overlay:

1. Expect deltas only from roles that exist in the live company roster. Do not invent absent roles.
2. Use cheap lanes for delta production: codex, gemini, or hermes. Do not use Claude for this reporting rail.
3. Keep each role delta to at most 10 structured lines with: role/date, shipped, blocked, next 24h, ask, and cash-path contribution.
4. If nothing changed, file exactly: `No material delta. Maintain plan. cash-path contribution: unchanged via current path.`
5. Keep the existing CEO sprint-report schedule as the single verdict rail.
6. In the CEO report, record `on-track`, `off-track`, or `intervene` for every expected role.
7. If a role delta is missing by the verdict slot, still file the CEO report and mark that role `intervene`.
8. For every `off-track` or `intervene`, name the next owner and exact action.

## Closeout Test

Before leaving a sprint-report issue:

- Latest confirmed source is issue/comment-specific, not a stale memory.
- Routine report status is `done` unless a real decision remains.
- CEO verdict covers every expected role.
- Missing/off-track/intervene entries name owner and action.
- No parallel report artifact or fake board review was created.
