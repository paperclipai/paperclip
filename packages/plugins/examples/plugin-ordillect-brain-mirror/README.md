# Ordillect Brain Mirror

First-party Paperclip plugin that mirrors every Paperclip issue-thread
comment into a per-issue **Honcho** session inside the
`ordillect-brain` workspace.

Ships as Phase-2 step P2.1 of the Ordillect brain plan
([AGE-81](../../../../../doc/plugins/PLUGIN_AUTHORING_GUIDE.md) →
`ordillect-brain`, tracked internally as **AGE-101**).

## What it does

On boot the plugin ensures the target Honcho workspace exists. It then
subscribes to `issue.comment.created` events. For each comment it:

1. Resolves the acting peer:
   - Registered leadership agent (CEO, CTO, CMO, ImplLead, UXDesigner,
     Hermes COO) → `agent-{role}` (matches
     `scripts/honcho-register-peers.mjs` in the Ordillect repo).
   - Other agent → `agent-{id}` (slugified).
   - Human commenter → `user-{userId}`.
   - Unknown / deleted author → `bot`.
2. Ensures a session with id `issue-{issueId}` exists, tagged with the
   issue identifier + title in `metadata`.
3. Ensures the peer exists and is attached to the session.
4. Posts the comment body as a Honcho message, with Paperclip provenance
   in `metadata` (`paperclip_comment_id`, `paperclip_issue_id`,
   `paperclip_issue_identifier`, `author_type`, `run_id`,
   `created_at`).

Sessions therefore become a **per-issue Honcho conversation** whose
participants match the Paperclip thread — the substrate the Hermes COO
and any future Honcho-native tooling read as episodic memory.

## Configuration

Instance config (see `manifest.ts`):

| Key | Default | Notes |
|-----|---------|-------|
| `honchoBaseUrl` | `http://agentic-honcho-api:8000` | Must be reachable from the Paperclip host; on the Ordillect Hetzner box use the Docker DNS name. |
| `honchoWorkspace` | `ordillect-brain` | Must be created and pre-populated with leadership peers (`scripts/honcho-register-peers.mjs`). |
| `honchoApiToken` | *(unset)* | Sent as `Authorization: Bearer <token>` when present. Leave blank when `USE_AUTH=false`. |

## Verifying

```bash
pnpm --filter @paperclipai/plugin-ordillect-brain-mirror typecheck
pnpm --filter @paperclipai/plugin-ordillect-brain-mirror test
pnpm --filter @paperclipai/plugin-ordillect-brain-mirror build
```

Then install into a running Paperclip instance from the local path and
comment on any issue. A new session named `issue-{id}` will appear in
the `ordillect-brain` workspace and the comment will show up as a
message with the matching peer.

## Capabilities

The manifest declares only the capabilities the worker actually uses:

- `events.subscribe` — receive `issue.comment.created` events.
- `issues.read`, `issue.comments.read` — hydrate the comment body.
- `agents.read` — optional peer-metadata enrichment.
- `http.outbound` — talk to the Honcho HTTP API.
- `plugin.state.read`, `plugin.state.write` — reserved for future
  dedupe cursor.
- `activity.log.write` — reserved for future activity emission.
