# paperclip-plugin-slack (in-tree fork)

In-tree fork of the upstream `paperclip-plugin-slack` npm package with two changes:

1. Adds `manifest.tools[]` so existing orchestration handlers (`escalate_to_human`,
   `handoff_to_agent`, `discuss_with_agent`, `process_media`, `register_command`,
   `register_watch`, `remove_watch`, `list_watch_templates`) actually reach agents.
2. Adds eleven Slack-API tools so agents can post messages, list channels, send
   DMs, search, react, upload files, and look up users.

Plugin key (`paperclip-plugin-slack`) and config schema are preserved — the
existing instance config and secrets carry over with no migration.

See `docs/superpowers/specs/2026-04-27-paperclip-plugin-slack-fork-design.md`.
