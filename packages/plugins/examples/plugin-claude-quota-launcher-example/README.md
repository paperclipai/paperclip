# @paperclipai/plugin-claude-quota-launcher-example

Example **launcher** plugin that adds a toolbar button which opens a **modal** showing Claude subscription quota usage.

## What it does

- Declares a single **declarative launcher** in `ui.launchers` with:
  - `placementZone: "toolbarButton"` — the host renders a button in the breadcrumb bar.
  - `action.type: "openModal"` — clicking the button opens a host-owned overlay.
  - `action.target: "ClaudeUsageModal"` — the overlay content is the exported React component.
- The modal fetches the company cost summary, per-agent usage, and **Claude subscription quota** and displays:
  - **Claude subscription quota**: 5-hour (rolling) and weekly utilization % and reset time from the [Anthropic OAuth usage API](https://github.com/openchamber/openchamber/blob/main/packages/web/server/lib/quota/providers/claude.js) (`GET https://api.anthropic.com/api/oauth/usage`). The OAuth access token is **set in plugin settings** (Settings → Plugins → Claude Quota (Example)).
  - This month’s spend, budget, and utilization.
  - Per-agent table with cost, subscription run count, and subscription input/output tokens (Claude subscription usage).

## Build and install

```bash
pnpm --filter @paperclipai/plugin-claude-quota-launcher-example build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-claude-quota-launcher-example
```

After installing, a **“Claude quota”** button appears in the toolbar. Select a company, click it, and the modal opens with usage data.

## Uninstall

```bash
pnpm paperclipai plugin uninstall paperclip.claude-quota-launcher-example --force
```

## Reference

- **Launcher placement:** `toolbarButton`
- **Launcher action:** `openModal` with `render: { environment: "hostOverlay", bounds: "wide" }`
- **Capabilities:** `ui.action.register`, `http.outbound`
- **Modal content:** Uses `useHostContext()` for `companyId` and:
  - `usePluginData("claude-quota")` — worker fetches 5hr and weekly quota from Anthropic using the token from plugin config.
  - Fetches `/api/companies/:companyId/costs/summary` and `.../costs/by-agent` with `credentials: "include"`.
- **Plugin settings:** Add `anthropicOAuthAccessToken` in the instance config (Settings → Plugins → Claude Quota (Example)). The worker calls `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <token>` and `anthropic-beta: oauth-2025-04-20`.

See `doc/plugins/PLUGIN_AUTHORING_GUIDE.md` for launcher and modal patterns.
