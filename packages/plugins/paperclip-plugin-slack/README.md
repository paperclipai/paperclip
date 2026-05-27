# paperclip-plugin-slack (in-tree fork)

In-tree fork of the upstream `paperclip-plugin-slack` npm package with three changes:

1. Adds `manifest.tools[]` so existing orchestration handlers (`escalate_to_human`,
   `handoff_to_agent`, `discuss_with_agent`, `process_media`, `register_command`,
   `register_watch`, `remove_watch`, `list_watch_templates`) actually reach agents.
2. Adds eleven Slack-API tools so agents can post messages, list channels, send
   DMs, search, react, upload files, and look up users.
3. Watches `issue.escalation.needs_human_decision` and posts a structured Slack
   escalation to `escalationChatId`, with per-issue duplicate suppression.

Plugin key (`paperclip-plugin-slack`) and config schema are preserved — the
existing instance config and secrets carry over with no migration.

See `docs/superpowers/specs/2026-04-27-paperclip-plugin-slack-fork-design.md`.

## Changelog

### 2.2.0

- Added the `issue.escalation.needs_human_decision` watch for stranded issues
  that need a human decision. Messages include the issue link, assignee,
  blocker identifiers, and Take ownership / View in Paperclip actions.
- Added `escalationDedupeWindowMs` to suppress duplicate Slack posts for the
  same issue inside the default one-hour dedupe window.
