# Token-cap exceptions

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
