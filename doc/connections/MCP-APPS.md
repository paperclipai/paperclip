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
| Chat | A run's views render with that run's reply, outside the folded tool history, under a "Widget from <app>" label with an "Open full screen" control. Views are keyed by the reply's run, so settled history needs no transcript. A task's views load in one request and are indexed by run once. | `ui/src/components/mcp-app/`, `TaskChatRunnerTurn.tsx` and `TaskChatThreadView.tsx` |
| View messages | A view's `ui/message` shows a card under the widget: "<App> wants to send: …" with Send and Dismiss. Nothing is sent until the viewer clicks Send. The text is then sent as the viewer's own comment through the chat's normal send path, exactly like a typed message. `POST …/:viewId/messages` then records `issue.mcp_app_message_sent` for that comment; it accepts only the caller's own comment on the same task from the last 10 minutes. | `McpAppView.tsx`, `server/src/routes/mcp-apps.ts` |
| View context | A view's `ui/update-model-context` is stored per view (`tool_mcp_app_views.model_context`, 16 KB at most) by `PUT …/:viewId/model-context`. Identical updates are deduped in the browser and on the server; a change logs `issue.mcp_app_context_updated`; an empty update clears it. The task's next run receives the three most recently updated contexts as an "App context (untrusted)" section of its wake prompt, quoted as JSON data and labelled as third-party data, not instructions. It is read in parallel with the other run preparation and never fails the run. | `server/src/services/mcp-app-views.ts`, `heartbeat/execution-configuration.ts`, `renderPaperclipWakePrompt` |
| Tool icons | Provider `icons` (SEP-973) on MCP tools are sanitized into `tool_catalog_entries.icons`, outside the version hash. Task chat tool rows and the app's actions list show them, falling back to the usual icons. | `server/src/services/tool-access/catalog/`, `ui/src/components/ProviderToolIcon.tsx` |

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
- `ui/message` waits for the viewer's decision: the view hears success only
  after the comment was sent, and "Message sending denied" when the viewer
  dismissed it. One proposal per view can wait at a time; further ones are
  refused until it is settled. Only text from the `user` role is accepted, up
  to 8,000 characters.
- `ui/update-model-context` is applied in order and deduped. Text blocks and
  `structuredContent` are kept; other content is dropped.
- `ui/request-display-mode` honors the view's declared `availableDisplayModes`.
  The host offers `inline` and `fullscreen` (no picture-in-picture) and answers
  with the resulting mode. Full screen is a Paperclip dialog; switching modes
  starts the view again in its new place, since a moved iframe always reloads.
  The view gets `host-context-changed` with the new mode and its container
  (a fixed `height` and `width` in full screen, `maxHeight` inline) and again
  when the full-screen container resizes.
- `message` and `updateModelContext` are advertised in `hostCapabilities` only
  where the viewer can send messages on the task. Without that, `ui/message`
  is refused (method not found) and context updates are accepted and dropped.
- Viewers who cannot comment on the task, agents and API keys cannot send a
  view's messages or set its context.

### Tool icons

Icons are untrusted provider data, so they are sanitized when the catalog is
refreshed and again before rendering:

- Only `https:` URLs and `data:image/*` URIs are kept. SVG is accepted only as
  a `data:` URI, never from a remote URL, so it cannot change after review.
- A `data:` icon is at most 32 KB; a URL at most 2,048 characters; at most
  four icons per tool. Unknown mime types, sizes and themes are dropped.
- Icons are always drawn as `<img referrerPolicy="no-referrer">` at a fixed
  size. Markup is never inlined, so an SVG's scripts never run. A broken icon
  falls back to the taxonomy icon.

## Testing plan

| Level | What it proves | Command or location |
| --- | --- | --- |
| Shared unit | `_meta.ui` parsing (current and legacy keys, visibility, non-`ui://` rejected), resource parsing (text and base64, mime check), CSP sanitizing | `pnpm exec vitest run packages/shared/src/mcp-apps.test.ts` |
| UI unit | Host protocol: initialize result, nothing sent before `initialized`, tool input before tool result, `tools/call` proxy and errors, link and method refusals, teardown. `ui/message` waits for the viewer and allows one proposal at a time; context updates are ordered, deduped and bounded; display modes honor the view's declaration; capabilities are advertised only when implemented. The consent card and the full-screen dialog. CSP placed before the view's markup. The run index at a realistic size. | `pnpm exec vitest run ui/src/components/mcp-app/` |
| Server integration (embedded Postgres) | Circleback catalog OAuth (DCR) against a fake Circleback server. `ui_meta` stored. An app-only tool is hidden from the agent. An agent call records one view with input, structured content and `_meta`, and a call without a view records none. Routes list the view and serve its document and CSP. A view's tool call works, and a model-only tool is refused. Other tasks, other companies and agent actors are refused. A view's context is stored, deduped, bounded, logged, cleared, and rendered for the task's next run as untrusted data. A view's message is attributed only to the viewer's own recent comment on the same task. | `pnpm exec vitest run server/src/__tests__/mcp-apps.test.ts` |
| Storybook | The view with the agent's reply, the ready view (Refresh calls a tool), loading, view unavailable, a tool call that needs approval, a view asking to send a message, full screen, and tool rows with provider icons. The fixture view follows the protocol by hand. | `Tasks/MCP App views` (`ui/storybook/stories/tasks/task-chat-mcp-app.stories.tsx`) |
| Live end to end | Connect Circleback with a real account and ask an agent for a recap of a recent meeting. Check that the chat shows the meeting cards and that clicking a card opens Circleback. Done on 2026-11-12. The run found the view-size and placement bugs. | Manual, local `pnpm dev` |

## Limits and follow-ups

- Picture-in-picture is not supported. Switching between inline and full
  screen restarts the view, so state inside the widget resets.
- A view's message is attributed in the activity log by a second request after
  the comment is sent. If that request fails, the comment stays, without the
  attribution.
- Icons are shown for tools only, not yet for MCP resources or prompts.
- Views are rendered in the task chat only, not in other transcript surfaces.
- A view document can be at most 4 MB of HTML. Circleback's is about 3.5 MB.
- Local stdio MCP servers are recorded the same way, but no stdio provider with
  views has been verified yet.
