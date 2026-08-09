# Token-cap exceptions

## Deterministic handler map

| Work class | Required directive and assignee | What it does | Forbidden fallback |
| --- | --- | --- | --- |
| TSM video assembly | routine-op: video-assembly → TSM RoutineOps | Calls scripts/video-assembly-shell.py, which sends the self-contained ffmpeg job through ~/scripts/mini-render.sh to mac-mini.tail3ef4e9.ts.net. The emitted metrics.json records renderer_host, renderer_route, and zero LLM-token fields. | No local Studio ffmpeg and no LLM assembly fallback. A Mini failure is a visible blocker with the job path and queue evidence. |
| TSBC completed-benchmark evidence | benchmark-op: report, aggregate, or package plus a safe benchmark-run-id → TSBC BenchmarkOps | Re-runs only the existing report/cost aggregation/package commands against completed benchmark evidence. | No model CLI, no sweep/orchestration, no benchmark retry. benchmark-op: orchestrate remains a scoped benchmark-manager responsibility. |

When an explicitly marked deterministic issue is aimed at an LLM assignee,
Paperclip rejects the assignment and returns eligible shell-handler suggestions.
Do not remove the directive to bypass that refusal.

Normal LLM work is capped at 400,000 tokens per run. The first run at or above
one million input tokens is automatically routed to split/route review; a
second on the same issue is blocked for a board decision.

The only current one-million-token exceptions are fixed TSBC benchmark-cell
runners. Their 1M cap is not permission for coordination, reporting, result
packaging, scheduling, or routine housekeeping:

| Agent | ID | Approved use |
| --- | --- | --- |
| Bench-codex-gpt-5.4 | `5bcc7a94-6715-43eb-ad53-da7bd300ef79` | Defined benchmark model cell only |
| Bench-gpt-5.6-sol | `9cde1342-a63e-48e5-ae32-769778cd5408` | Defined benchmark model cell only |
| Bench-gpt-5.6-luna | `aaecdcd0-dc5b-41d1-a6fd-0ff7a56776a0` | Defined benchmark model cell only |
| Bench-gpt-5.6-terra | `9dc76a01-420e-440f-a76e-2c0d097acf7d` | Defined benchmark model cell only |

Use `benchmark-op: orchestrate|report|aggregate|package`, `routine-op: ...`,
or `execution-mode: deterministic` for mechanical issue work. Paperclip then
requires a `paperclip_shell_handler` assignee, preventing an LLM lane wake.
