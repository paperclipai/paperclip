# Hermes CLI fixture corpus

These fixtures are normalized captures from a live Hermes Agent v0.7.0 CLI on this development box.

Normalization applied:
- dynamic session ids are replaced with `SESSION_ID`
- original line wrapping and Unicode glyphs are preserved so parser regressions stay visible

Fixture set:
- `banner-simple.stdout`: non-quiet query with startup banner and assistant panel
- `banner-tool.stdout`: non-quiet query with startup banner, tool preview, and assistant panel
- `quiet-simple.stdout`: quiet query with assistant panel and trailing `session_id`
- `quiet-tool.stdout`: quiet query with tool preview and assistant panel
- `quiet-write-diff.stdout`: quiet query with write preview, inline diff, and assistant panel
- `quiet-failed-shell.stdout`: quiet query with failed shell preview using `[exit 7]`

Refresh path:
- run [capture-fixtures.sh](/home/toor/paperclip/packages/adapters/hermes-local/tests/capture-fixtures.sh)
- optionally set `HERMES_CAPTURE_MODEL`, `HERMES_CAPTURE_PROVIDER`, or `HERMES_CAPTURE_WORKDIR`

When Hermes formatting changes upstream, refresh these captures intentionally and rerun the parser tests.
