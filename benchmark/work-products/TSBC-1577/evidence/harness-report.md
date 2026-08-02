# VA1 Compliance Suite - `va1-20260730-203722`

- Suite: `va1_compliance`
- Suite source: `/Users/glad0s/paperclip/benchmark/va1_compliance/suite.json`
- Suite sha256: `83a4dba5e21fe520a46be96a12aab68029dc7f5abd62140ebfb94c9ff5ddc01b`
- Reps: `3`
- Models: `grok-4.3, codex-gpt-5.4, claude-sonnet-5`
- Verdict: `blocked`

## Preflight

- Power mode: `low`
- Heavy allowed: `False`
- Blockers: `2`
- Blocker: TSBC power gate heavyTasksAllowed=false (mode=low, reason=ThinkStack Capital sprint 13-23; ThinkStack Media sprint 09-03)
- Blocker: claude-sonnet-5 agent Bench-claude-sonnet-5 is paused (manual)


## Ledger

- Run directory: `/Users/glad0s/paperclip/benchmark/results/va1-20260730-203722`
- Ledger suite namespace: `va1_compliance`
- Scoring: deterministic served-state artifact checks, no LLM judge.
