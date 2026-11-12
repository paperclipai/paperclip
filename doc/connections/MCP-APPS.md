# MCP Apps: interactive views in the task chat

Some MCP servers attach an interactive view to a tool. When an agent calls the
tool, the view appears in the task chat under the tool row. The first provider
that uses this is [Circleback](./CIRCLEBACK.md): `DisplayMeetings`,
`DisplayActionItems` and `DisplayCalendarEvents` render meeting, action item and
calendar cards.

## The standard

These views are **MCP Apps**, the first official MCP extension:

- Specification: [SEP-1865, version 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
  ([overview](https://modelcontextprotocol.io/docs/extensions/apps)).
- Extension id: `io.modelcontextprotocol/ui`.
- Other hosts: Claude, Claude Desktop, Claude Code, VS Code Copilot, Goose and Postman.

The protocol works like this:

1. **The tool declares a view.** The tool's `_meta.ui.resourceUri` names a
   `ui://` resource. `_meta.ui.visibility` lists who may call the tool:
   - `"model"` means the agent can call it. The default is `["model", "app"]`.
   - A tool marked `["app"]` is hidden from the agent and only the view can call it.
   - Paperclip also reads the deprecated flat key `_meta["ui/resourceUri"]`.
2. **The resource is an HTML document.** `resources/read` returns it with the
   mime type `text/html;profile=mcp-app`. The resource's `_meta.ui` can also
   carry:
   - `csp.connectDomains`, `resourceDomains`, `frameDomains` and `baseUriDomains`;
   - `permissions`;
   - `prefersBorder`.
3. **The host renders the view in a sandboxed iframe.** The host and view then
   talk JSON-RPC over `postMessage`:
   1. The view sends `ui/initialize` and the host answers with its capabilities
      and host context: theme, style variables, locale, size limits and tool info.
   2. The view sends `ui/notifications/initialized`.
   3. The host sends `ui/notifications/tool-input` and then
      `ui/notifications/tool-result`, which carries the full `CallToolResult`,
      including `structuredContent` and `_meta`.
   4. After that, the view may send `ui/notifications/size-changed`,
      `tools/call`, `ui/open-link`, `ui/update-model-context` and `ping`.
   5. Before removing the iframe, the host sends `ui/resource-teardown`.

## Composio and other aggregators

The [Composio Circleback toolkit](https://docs.composio.dev/toolkits/circleback_mcp)
cannot carry views:

- It has 11 read tools.
- It has none of the `Display*` tools.
- Composio's meta-tools return plain JSON.

So views need a direct MCP connection, and Circleback is now a native catalog
app. When an app has a native entry, search prefers it over its aggregator
listing. See [CONNECTION-SEARCH.md](./CONNECTION-SEARCH.md).

## How Paperclip implements it

| Layer | What happens | Code |
| --- | --- | --- |
| Client capability | Paperclip advertises `extensions["io.modelcontextprotocol/ui"]` when it initializes an MCP session. | `server/src/services/mcp-http.ts` |
| Catalog | Each tool's normalized `_meta.ui` is kept in `tool_catalog_entries.ui_meta`. It is not part of the version hash, so adding a view never quarantines a reviewed tool. | `server/src/services/tool-access/catalog/` |
| Agent tool list | Tools whose visibility omits `"model"` are not listed to agents and cannot be called by them. | `isModelVisibleTool` in `server/src/services/tool-gateway.ts` |
| Recording | Each successful call to a tool with a view stores one `tool_mcp_app_views` row: issue, run, agent, connection, the redacted arguments and the redacted `CallToolResult`. The tool result `_meta` is kept here and never sent to the agent. Recording is best effort and never fails the agent's call. | `server/src/services/mcp-app-views.ts` |
| API | `GET /api/issues/:issueId/mcp-app-views` lists a task's views. `GET …/:viewId` returns the view, reading the `ui://` document live through the agent's connection. `POST …/:viewId/tool-calls` runs a view's `tools/call`. Reading follows task read access. Tool calls also need the `tools:use` or `tools:manage_connections` permission, and only reach tools of the same connection that allow `"app"`. They go through the same policy, Ask-first approval and audit path as a connection test call. | `server/src/routes/mcp-apps.ts` |
| Chat | A completed MCP tool row finds its view by run, tool name and arguments, then renders it under the row. | `ui/src/components/mcp-app/` and `TaskChatToolCard.tsx` |

### Sandbox

The view runs in a `srcdoc` iframe with `sandbox="allow-scripts allow-popups
allow-popups-to-escape-sandbox"`. It never gets `allow-same-origin`. Its origin
is therefore opaque, so it cannot read Paperclip's DOM, cookies or storage, and
it cannot call the Paperclip API.

The spec's double-iframe proxy on a separate origin solves the same problem for
hosts that render on their own origin. Paperclip uses a single opaque-origin
frame instead and installs the CSP itself:

- The CSP is a `<meta http-equiv>` placed before any of the view's markup.
- It starts from the spec's restrictive default and adds only well-formed
  `https://` origins that the server declared.
- Keywords, schemes, paths and `*` are dropped.
- Without declared origins, `connect-src` and `frame-src` are `'none'`.

Messages are accepted only from the iframe's own window. The host sends nothing
until the view reports `initialized`.

The host answers view requests as follows:

- `ui/open-link` opens only `http(s)` URLs, in a new tab without an opener.
- `ui/message` is refused (method not found), because posting to the task on
  the user's behalf needs its own consent flow.
- `ui/update-model-context` is accepted but not yet sent to the agent.
- Display mode is always `inline`.

## Testing plan

| Level | What it proves | Command or location |
| --- | --- | --- |
| Shared unit | `_meta.ui` parsing (current and legacy keys, visibility, non-`ui://` rejected), resource parsing (text and base64, mime check), CSP sanitizing | `pnpm exec vitest run packages/shared/src/mcp-apps.test.ts` |
| UI unit | Host protocol: initialize result, nothing sent before `initialized`, tool input before tool result, `tools/call` proxy and errors, link and method refusals, teardown. CSP placed before the view's markup. Row-to-view matching. | `pnpm exec vitest run ui/src/components/mcp-app/` |
| Server integration (embedded Postgres) | Circleback catalog OAuth (DCR) against a fake Circleback server. `ui_meta` stored. An app-only tool is hidden from the agent. An agent call records one view with input, structured content and `_meta`, and a call without a view records none. Routes list the view and serve its document and CSP. A view's tool call works, and a model-only tool is refused. Other tasks, other companies and agent actors are refused. | `pnpm exec vitest run server/src/__tests__/mcp-apps.test.ts` |
| Storybook | The tool row with its view, the ready view (Refresh calls a tool), loading, view unavailable, and a tool call that needs approval. The fixture view follows the protocol by hand. | `Tasks/MCP App views` (`ui/storybook/stories/tasks/task-chat-mcp-app.stories.tsx`) |
| Live end to end | Connect Circleback with a real account, ask an agent for a recap of a recent meeting, and check that the chat shows the meeting cards and that clicking a card opens Circleback. | Manual, local `pnpm dev`. Record the result in the PR. |

## Limits and follow-ups

- Only `inline` display mode is supported. There is no fullscreen or
  picture-in-picture yet.
- A view's `ui/message` and `ui/update-model-context` do not reach the agent yet.
- Views are rendered in the task chat only, not in other transcript surfaces.
- Local stdio MCP servers are recorded the same way, but no stdio provider with
  views has been verified yet.
