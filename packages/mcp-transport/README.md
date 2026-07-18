# @paperclipai/mcp-transport

Shared, server-agnostic transport + auth layer for Paperclip MCP servers.

Extracted from `plugins/honcho/src/mcp` (`runner.ts` + `auth.ts`) so any MCP
server definition can be served in two modes from one code path:

- **`--stdio` (default)** — one process per launch, identity derived from the
  process environment. Ideal for per-turn harness spawns.
- **`--http --port N`** — a Node HTTP server that resolves a fresh, per-request
  config (typically from a bearer token), for multi-tenant external exposure
  behind an auth gate. Binds to `127.0.0.1` by default; front it with a proxy.

## Usage

```ts
import { runFromArgv, createSsmTokenAuthenticator } from "@paperclipai/mcp-transport";

await runFromArgv({
  name: "my-mcp",
  buildServer: (config) => createMyServer(config), // returns an McpServer-like
  configFromEnv: () => configFromEnv(),            // stdio scope
  authenticate: createSsmTokenAuthenticator({      // http scope
    paramPrefix: "/my/mcp/tokens",
    toConfig: (binding) => ({ /* map SSM JSON binding -> config */ }),
  }),
});
```

### Token → binding auth

`createSsmTokenAuthenticator` resolves a bearer token to a JSON binding stored in
AWS SSM Parameter Store at `<paramPrefix>/<token>`, then maps that binding to a
transport config. Hardening over the honcho reference:

- tokens are validated against a strict URL-safe charset before use;
- the `aws` CLI is invoked without a shell (`execFileSync`);
- the SSM reader is injectable (`readParameter`) for native-SDK use and tests;
- a failed lookup is reported as `UnauthorizedError` (no existence leak); a
  malformed stored binding is reported as `TokenBindingError` (HTTP 500).
