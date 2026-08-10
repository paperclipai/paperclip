# nideas Routing Board — Paperclip plugin

Routing selector for Paperclip: pick a **routing** (orchestrator × model) when
creating tasks / running heartbeats, with an additive registry and per-agent
defaults. Appears as a **Routing** page + sidebar entry under the company.

## Install (local path)

```bash
# build (bundles worker + UI; worker is fully self-contained)
pnpm --filter @nideas/routing-board-plugin build

# install into a running Paperclip instance
paperclipai plugin install ./packages/plugins/routing-board
```

Result: `status=ready`, Routing page at `/:companyPrefix/routing`, 6 tools.

## Tools

| Tool | Purpose |
| --- | --- |
| `routing-list` | List routings + availability + agents |
| `routing-get` | Get one routing's full config |
| `routing-set-default` | Record an agent's default routing (UI applies via API) |
| `routing-create` | Add a routing to the additive registry |
| `routing-delete` | Remove a non-builtin routing |
| `routing-heartbeat` | Record heartbeat-with-routing intent (UI performs API calls) |

## Policies

- **FREE LANES ONLY** (config `freeLanesOnly`, default true): claude-backed
  lanes (`cc`, `cc-bridge`, `cc-or`, `cc-ds`) are marked unavailable — the
  board's NON-NEGOTIABLE cost policy.
- `defaultRouting` config: lane applied when an agent has none.

## How routing is applied

The plugin SDK's curated host client exposes no `agents.update`, so the plugin
UI applies a routing to an agent via Paperclip's own REST API (same-origin,
board session auth):

```
PATCH /api/agents/:id   { adapterType, replaceAdapterConfig: true, adapterConfig }
POST  /api/agents/:id/heartbeat/invoke   (when a heartbeat is requested)
```

Sensitive env values are passed as `secret_ref` bindings; never plaintext keys.

## Runtime note (why the worker is bundled)

`@paperclipai/shared` exports `src/*.ts`; a forked Node worker cannot execute
it. The worker bundle therefore inlines the SDK (esbuild
`external: ["react","react-dom"]`). If you externalize the SDK, local-path
installs crash on worker init with `ERR_MODULE_NOT_FOUND` for
`shared/src/adapter-type.js`.

## UI

`src/ui/index.tsx` — Routing page (agents + registry + availability + add-form)
and sidebar slot. Exports `RoutingPage` and `RoutingSidebarLink` (matches
manifest `exportName`s).
