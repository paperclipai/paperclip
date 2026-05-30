# @paperclipai/adapter-shared

Shared building blocks for Paperclip CLI adapter packages.

This package is internal to the Paperclip monorepo; it is not intended
to be consumed by third parties. Adapter packages (`claude-local`,
`gemini-local`, `codex-local`, `opencode-local`) depend on it as a
workspace dependency.

## What it provides today

### Plugin Tools MCP bridge

A single stdio MCP server (`paperclip-mcp-bridge`) plus per-CLI
helpers that materialize its config into each adapter's native MCP
config format. Every CLI child spawns the same bridge binary; the
bridge is a thin proxy from MCP `tools/list` and `tools/call` to the
host's `/api/plugins/tools` endpoints.

See `KSI-664` for the design decision and `KSI-698` for the
implementation issue. Public API:

```ts
import {
  buildPluginToolsMcpServer,
  materializeClaudeMcpConfigFile,
  mergeGeminiSettingsMcpServer,
  mergeCodexConfigMcpServers,
  mergeOpencodeConfigMcpServers,
} from "@paperclipai/adapter-shared";
```

The adapter calls `buildPluginToolsMcpServer({ runContext, apiUrl,
apiKey })` once per run, gets a `PluginToolsMcpServerSpec`, and then
calls the materializer that matches its CLI. The CLI then takes care
of spawning the bridge as a subprocess.

The bridge entrypoint is `paperclip-mcp-bridge` (resolved automatically
via `bin` after `pnpm install`).
