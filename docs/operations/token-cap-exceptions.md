# Token-cap exceptions

## Deterministic handler map

| Work class | Required directive and assignee | What it does | Forbidden fallback |
| --- | --- | --- | --- |
| TSM video assembly | routine-op: video-assembly → TSM RoutineOps | Calls scripts/video-assembly-shell.py, which sends the self-contained ffmpeg job through ~/scripts/mini-render.sh to mac-mini.tail3ef4e9.ts.net. The emitted metrics.json records renderer_host, renderer_route, and zero LLM-token fields. | No local Studio ffmpeg and no LLM assembly fallback. A Mini failure is a visible blocker with the job path and queue evidence. |
| TSBC completed-benchmark evidence | benchmark-op: report, aggregate, or package plus a safe benchmark-run-id → TSBC BenchmarkOps | Re-runs only the existing report/cost aggregation/package commands against completed benchmark evidence. | No model CLI, no sweep/orchestration, no benchmark retry. benchmark-op: orchestrate remains a scoped benchmark-manager responsibility. |

When an explicitly marked deterministic issue is aimed at an LLM assignee,
Paperclip rejects the assignment and returns eligible shell-handler suggestions.
Do not remove the directive to bypass that refusal.

## Token-limit enforcement status

The operating target for normal LLM work is **250–400K input tokens per run**.
The first run at or above one million input tokens is automatically routed to
split/route review; a second on the same issue is blocked for a board decision.

Do not describe that target as a universal hard stop. The enforcement available
today differs by adapter:

| Control | Enforcement | Notes |
| --- | --- | --- |
| Paperclip ≥1M first/second-run rule | Hard post-run routing/block | Applies portfolio-wide using the recorded input usage. |
| `maxTurnsPerRun` | Hard | Stops another tool turn; a missing valid terminal disposition is blocked and escalated. |
| Hermes 250–400K target | Task instruction and run review | Hermes has no native cumulative-input-token CLI limit. `HERMES_MAX_TOKENS` limits output, not total input/context. Keep Hermes tasks bounded by source count, tool count, and turns until a measured pre-emptive budget controller is available. |

For a Hermes controlled proof, use one source, a named evidence artifact, a
small explicit turn limit, and no downstream side effects. A task that reaches
its turn limit without a durable `PAPERCLIP_DISPOSITION` must stay blocked; do
not retry it or schedule a successful-run handoff.

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
