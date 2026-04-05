# Hermes CLI Output Audit

This document maps the Hermes CLI strings Paperclip currently relies on to the parser logic in `src/server/parse.js`.

## Scope

The audit covers the `hermes chat -q ...` run path that the Paperclip adapter executes for agent work.
That includes output from Hermes' panel renderer, tool preview renderer, reasoning preview, and single-query exit summary.
It does not try to parse standalone admin subcommands such as:

- `hermes skills ...`
- `hermes cron ...`
- `hermes status`
- `hermes profiles ...`

Those commands are useful for operator tooling, but they are not the transcript format consumed by Paperclip heartbeat runs.

## Hermes sources audited

- `~/.hermes/hermes-agent/hermes_cli/banner.py`
- `~/.hermes/hermes-agent/hermes_cli/skin_engine.py`
- `~/.hermes/hermes-agent/agent/display.py`
- `~/.hermes/hermes-agent/cli.py`

## Parsed surfaces

| Hermes emitter | Example shape | Paperclip behavior | Coverage |
| --- | --- | --- | --- |
| banner header from `banner.py` | `╭── Hermes Agent v0.7.0 (...) ──╮` | suppressed | fixture + custom-skin tests |
| compact skin banner | boxed `NOUS HERMES` banner | suppressed | custom-skin test |
| tools / skills banner body | `Available Tools`, `Available Skills`, session summary panel rows | suppressed | fixture tests |
| prompt echo from `cli.py` | `Query: ...` block | suppressed | fixture tests |
| run bootstrap | `Initializing agent...` and separator line | suppressed | fixture + inline tests |
| non-TTY spinner bootstrap from `display.py` | `[tool] running terminal command` | suppressed | source-backed + inline tests |
| reasoning panel | `┌─ Reasoning ─...┐` | emitted as `thinking` lines without borders | custom-skin test |
| response panel | `╭─ ⚕ Hermes ... ╮` or other skin title | emitted as `assistant` text | fixture + custom-skin tests |
| tool preparation | `preparing terminal…` | suppressed | inline parser test |
| tool completion rows from `display.py:get_cute_tool_message()` | `┊ 💻 $ pwd 0.2s` | emitted as `tool_call` + `tool_result` | direct parser test |
| inline assistant tool note | prefixed `💬 ...` line | emitted as `assistant` | parser implementation covered |
| inline diff preview | `review diff`, file header, hunks, add/remove/context lines | emitted as `diff` entries | fixture tests |
| diff truncation line | `… omitted 12 diff line(s)` | emitted as `diff` truncation entry | inline parser test |
| resume footer | `Resume this session with:` + `hermes --resume ...` | suppressed | inline parser test |
| alternate resume hint | `hermes -c "Session title"` | suppressed | inline parser test |
| exit summary | `Session:`, `Duration:`, `Messages:` | suppressed | inline parser test |
| `session_id: ...` line | machine session id | suppressed in live transcript, extracted by `parseHermesOutput()` | response parser test |
| `[thinking] ...` preview | dim single-line or wrapped reasoning preview | emitted as `thinking` entries | inline parser test |
| context-reference status from `cli.py` | `[@ context: 2 ref(s), 137 tokens]` | emitted as `system` | source-backed + inline tests |
| warning / init failure lines from `cli.py` | `⚠ ...`, `Failed to initialize agent: ...`, `Session not found: ...` | emitted as `stderr` | source-backed + inline tests |
| Paperclip wrapper log lines | `[paperclip] ...`, `[hermes] ...` | emitted as `system` entries | parser implementation |
| timestamped log/error lines | `[2026-...] ...` | emitted as `stderr` entries | parser implementation |
| leaked interactive noise | `Honcho session: ...`, `context ... to compaction` | suppressed defensively | inline parser test |
| leaked bare banner summary rows | `Profile: ...`, `31 tools · ... /help for commands`, `⚠ 8 commits behind ...` | suppressed defensively | source-backed audit test |

## Parser design notes

- Banner parsing is skin-tolerant. The header regex does not hardcode `Hermes Agent`; it accepts custom skin names and version strings.
- Tool preview parsing is action-based, not glyph-based. The parser accepts Hermes' different left prefixes such as `┊`, `╎`, and `│`.
- Hermes' generic fallback tool rows truncate tool names to nine characters. The adapter keeps explicit aliases for known truncated built-ins such as `skill_man -> skill_manage`.
- Hermes' non-TTY spinner startup line (`[tool] ...`) is treated as transport noise. The meaningful event is the later `[done]` completion row, which is what Paperclip converts into `tool_call` and `tool_result`.
- Context-reference bookkeeping such as `[@ context: ...]` is preserved as `system` so transcript viewers can explain extra prompt tokens without pretending the model said it.
- Hermes operational warnings and startup failures are surfaced as `stderr` entries so startup problems do not look like assistant content.
- Response extraction keeps structured tool and diff events visible to Paperclip instead of forcing Hermes `-Q` quiet mode.
- A small amount of interactive-only noise is suppressed defensively even though `chat -q` should not normally emit it.

## Source-backed audit

When the local Hermes source checkout is available, `tests/parse-source-audit.test.js` reads:

- `agent/display.py`
- `hermes_cli/banner.py`
- `cli.py`

and verifies that the installed Hermes version still matches the parser's
coverage assumptions.

This is intentionally additive:

- fixture tests remain the portable baseline
- source-backed audit catches local Hermes drift before it becomes transcript noise

## Known limitations

- Hermes wraps panel text for terminal display before Paperclip receives it, so paragraph wrapping cannot be perfectly reconstructed.
- If Hermes adds brand new tool action verbs in `get_cute_tool_message()`, `parseToolCompletionLine()` may need a mapping update.
- Standalone Hermes admin commands are intentionally out of scope for the Paperclip transcript parser.
- Interactive shell banners such as `/help`, `/tools`, or history views are intentionally out of scope because Paperclip does not execute those commands during heartbeat runs.
