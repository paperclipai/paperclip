# In-tree fork of `paperclip-plugin-slack` with agent-callable Slack tools

Date: 2026-04-27
Owner: Omar Ramadan
Status: Approved (design); pending implementation plan

## Background

The Slack integration is "installed" but agents have no Slack tools. Two distinct problems were identified:

1. **No tools reach agents.** The published upstream plugin (`paperclip-plugin-slack@2.0.7`, by `mvanhorn`) declares zero tools in its manifest. Its worker calls `ctx.tools.register(...)` for eight handlers (`escalate_to_human`, `handoff_to_agent`, `discuss_with_agent`, `process_media`, `register_command`, `register_watch`, `remove_watch`, `list_watch_templates`), but `ctx.tools.register` in the SDK is a worker-local `Map.set`. Without a manifest declaration, the host-side `PluginToolRegistry.registerPlugin` (which reads `manifest.tools ?? []`) registers nothing, and agents never see those tools.
2. **No Slack-API tools exist at all.** Even if the eight orchestration handlers surfaced, none of them call Slack APIs from an agent context. There is no `slack_post_message`, `slack_list_channels`, etc.

Result: an agent assigned a Slack-related task ("set up Slack", "list Slack channels", "DM Daisy") has nothing to call and falls back to clarifying questions.

This spec covers fixing the plugin. A separate, smaller host-side change (slash-command webhook ack returning empty body so Slack stops rendering `{deliveryId, status}` in chat) is **out of scope here**.

## Goal

Replace the upstream npm `paperclip-plugin-slack` with an in-tree fork that:

- Preserves all existing webhook/notification/orchestration behavior.
- Declares its existing handlers as manifest tools so they reach agents.
- Adds eleven Slack-API tools so agents can act on Slack directly.
- Reuses the existing DB plugin row, secrets, and instance config — zero data migration.

## Non-goals

- Rewriting the upstream escalation / multi-agent ACP architecture.
- Subscribing to `app_mention` / DM events (would require new bot scopes and a routing handler — deliberate non-goal here).
- Fixing the slash-command JSON-rendering issue in the host webhook route.
- Publishing the fork back to npm.

## Identity and migration

- **Plugin key remains `paperclip-plugin-slack`.** This matches the existing DB row (instance: `9ab29423-a0d3-438c-9310-5b6120fa7a5c`) so `slackTokenRef`, `slackSigningSecretRef`, `defaultChannelId`, escalation channels, and any other config are unchanged.
- **Workspace package name: `paperclip-plugin-slack`** (same as the npm package). The host loader resolves bundled plugins by package name; matching avoids a special case.
- **`BUNDLED_PLUGINS` change** (`server/src/index.ts:67`): drop the entry so the npm auto-install stops on each startup. The local workspace copy takes its place.
- **One-time cleanup the human owner runs**: `pnpm -w remove paperclip-plugin-slack` to drop the npm dependency from the workspace lockfile. Optionally `rm -rf ~/.paperclip/plugins/node_modules/paperclip-plugin-slack` to clear the residual install dir. Loader resolution order will be verified during implementation; if a leftover npm copy can shadow the workspace copy, we install the local fork through the host's existing install API by package path so the DB row's resolved path points to the workspace.

## Layout

```
packages/plugins/paperclip-plugin-slack/
├── package.json            # name: "paperclip-plugin-slack", workspace deps on @paperclipai/plugin-sdk + @paperclipai/shared
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── manifest.ts         # adds tools[] (this is the headline change)
│   ├── worker.ts           # binds handlers; new tool handlers added
│   ├── slack-api.ts        # extended with all needed Slack endpoints
│   ├── acp-bridge.ts       # unchanged from upstream
│   ├── custom-commands.ts  # unchanged
│   ├── media-pipeline.ts   # unchanged
│   ├── proactive-suggestions.ts  # unchanged
│   ├── formatters.ts       # unchanged
│   ├── adapter.ts          # unchanged
│   ├── constants.ts        # unchanged
│   ├── types.ts            # extended for new tool param shapes
│   └── __tests__/
│       └── tools.test.ts   # vitest unit tests for new tool handlers
└── README.md
```

Source is recovered from the published `dist/` (already on disk at `~/.paperclip/plugins/node_modules/paperclip-plugin-slack/dist/`) and converted back to TypeScript. Modules we do not modify keep upstream shape verbatim — minimum drift in the parts that already work.

## Tool surface (eleven)

All declared in `manifest.tools[]` so the host registers them. Handlers bound at worker start via `ctx.tools.register(name, declaration, fn)` and route through extended `slack-api.ts`.

| Tool | Slack API | Inputs (required) | Notes |
|---|---|---|---|
| `slack_post_message` | `chat.postMessage` | `channel`, `text` (or `blocks`) | Optional `thread_ts` |
| `slack_update_message` | `chat.update` | `channel`, `ts`, `text` (or `blocks`) | |
| `slack_react` | `reactions.add` | `channel`, `timestamp`, `name` | Emoji name without colons |
| `slack_send_dm` | `conversations.open` → `chat.postMessage` | `user` (id or email), `text` | If email, resolve via `users.lookupByEmail` first |
| `slack_list_channels` | `conversations.list` | none | Optional `types`, `name_filter`, `cursor`, `limit` |
| `slack_join_channel` | `conversations.join` | `channel` | Public channels only |
| `slack_list_users` | `users.list` | none | Optional `cursor`, `limit`; filters out bots/deleted |
| `slack_get_user_info` | `users.lookupByEmail` / `users.info` | `user` (id or email) | |
| `slack_get_thread_replies` | `conversations.replies` | `channel`, `thread_ts` | |
| `slack_search_messages` | `search.messages` | `query` | **Requires user token.** Reads from new optional `slackUserTokenRef`. Returns descriptive error if absent — does not block the tool from registering. |
| `slack_upload_file` | `files.getUploadURLExternal` + `files.completeUploadExternal` | `channel`, `filename`, and either `content_base64` or `source_url` | If `source_url`, fetch via `ctx.http.fetch` first |

**Plus the eight existing orchestration handlers**, now properly declared in `manifest.tools[]` so they finally reach agents: `escalate_to_human`, `handoff_to_agent`, `discuss_with_agent`, `process_media`, `register_command`, `register_watch`, `remove_watch`, `list_watch_templates`. Bodies unchanged from upstream.

Total declared tool count: **19**.

Each new handler:
1. Reads the bot token via `ctx.secrets.read(slackTokenRef)`.
2. Calls the relevant `slack-api.ts` function (existing or newly added).
3. Returns `{ output: <Slack response, slimmed to relevant fields> }` on `ok: true`, or `{ error: <Slack error code + message> }` on `ok: false`.
4. Increments `slack.tool.<name>.{success,error}` metrics.

## Manifest changes

```ts
const manifest: PaperclipPluginManifestV1 = {
  // ...everything currently in upstream manifest.js (id, capabilities, jobs, webhooks, instanceConfigSchema)...
  tools: [
    // 11 new Slack-API tools (declarations matching the table above)
    // 8 existing orchestration handlers
  ],
  instanceConfigSchema: {
    properties: {
      // ...existing properties...
      slackUserTokenRef: {  // NEW (optional)
        type: "string",
        format: "secret-ref",
        title: "Slack User Token (secret reference, optional)",
        description: "Required for slack_search_messages. Bot tokens cannot use search.messages.",
      },
    },
    // required[] unchanged — slackUserTokenRef is opt-in
  },
};
```

## What's preserved (no behavior change)

- Webhook handling: events API, slash commands (`/clip status|agents|issues|approve|acp|commands|watches|help`), interactivity buttons.
- All existing plugin jobs (`daily-digest`, `check-escalation-timeouts`, `check-watches`).
- All existing manifest config keys.
- All existing capabilities.

## Testing

- **Unit (vitest)**: For each new tool handler, mock `ctx.http.fetch` and `ctx.secrets.read`, assert URL + body + headers match the Slack API spec, assert success/error mapping. One file: `src/__tests__/tools.test.ts`.
- **Regression (manual)**: After the fork is loaded, run `/clip status` and `/clip agents` from Slack to confirm webhook flow still works.
- **End-to-end (manual)**: Assign an agent a task that mentions Slack ("post a hello message to #general"). Confirm the tool is offered, called, and the message appears in Slack.

## Open implementation risks (resolved during plan, not here)

1. **Loader resolution order.** Need to confirm whether `pluginLoader` prefers `~/.paperclip/plugins/node_modules/<pkg>` or the workspace copy. If the leftover shadows, install the fork through the host's local-path install API and accept that as the documented one-time setup.
2. **Slack search scope token.** `search.messages` needs a user token. The `slackUserTokenRef` config above + graceful degradation handles this without blocking the rest.
3. **`files.upload` deprecation.** Slack deprecated the v1 endpoint. Using the two-step `files.getUploadURLExternal` + `files.completeUploadExternal` flow.

## Out-of-scope follow-ups

- Host-side fix: slash-command webhook should return empty 200 OK so Slack stops rendering `{deliveryId, status}` JSON in chat. Tracked separately.
- Adding `app_mention` / DM event subscription so users can talk to agents directly in Slack channels (requires bot scope changes and an event router).
