# Paperclip Honcho Plugin

Optional Honcho memory integration for Paperclip.

## What It Does

- syncs Paperclip issue comments into Honcho
- optionally syncs issue document revisions in sectioned chunks
- exposes Honcho retrieval tools to agents
- adds an issue Memory tab for operators
- adds a custom plugin settings page for setup, validation, connection testing, and company backfill

Paperclip stays the system of record. Honcho is used as a derived memory layer.

## Development

```bash
pnpm install
pnpm --filter paperclip-plugin-honcho build
pnpm --filter paperclip-plugin-honcho test
```

## Install Into Paperclip

```bash
pnpm --filter paperclip-plugin-honcho build
pnpm paperclipai plugin install ./packages/plugins/paperclip-plugin-honcho
```

## Initial Setup

1. Create a Paperclip secret containing the Honcho API key.
2. Open the Honcho plugin settings page in Paperclip.
3. Set:
   - `honchoApiBaseUrl`
   - `honchoApiKeySecretRef`
   - `workspacePrefix` if you want something other than `paperclip`
4. Save settings.
5. Either click `Save And Initialize`, or run `Validate Config`, `Test Connection`, and `Backfill Current Company` manually.
6. Confirm the readiness checklist shows the company as backfilled.

Recommended starting configuration:

- `syncIssueComments: true`
- `syncIssueDocuments: false`
- `enablePeerChat: false`

Enable document sync only after the connection is validated.

## Current Capabilities

The plugin requests:

- `issues.read`
- `issue.comments.read`
- `issue.documents.read`
- `agents.read`
- `plugin.state.read`
- `plugin.state.write`
- `events.subscribe`
- `agent.tools.register`
- `http.outbound`
- `secrets.read-ref`
- `instance.settings.register`
- `ui.detailTab.register`
- `ui.dashboardWidget.register`

## Agent-Facing Tools

- `honcho_get_issue_context`
- `honcho_search_memory`
- `honcho_ask_peer` when `enablePeerChat` is enabled

## Notes

- This integration is easiest to run in the current self-hosted Paperclip plugin model.
- Agent usage is currently strongest through plugin tools rather than automatic prompt-time memory injection.
