# Sandbox `@next` API documentation

Use this reference after the **sandbox-next** package-line gate. Existing stable apps use **sandbox-stable**; stable-to-preview migrations use **sandbox-migrate-to-next**.

Fetch the page for the task before implementing and check signatures against installed `@cloudflare/sandbox@next` types.

| Task | Documentation |
| --- | --- |
| Launch commands, collect output, stream logs, wait for readiness, inspect or stop processes | [Processes API](https://developers.cloudflare.com/sandbox/1-0-preview/api/processes/) and [Process execution](https://developers.cloudflare.com/sandbox/1-0-preview/processes/) |
| Understand sandbox IDs, container lifetime, sleep, destruction, and durable state | [Sandbox lifecycle](https://developers.cloudflare.com/sandbox/1-0-preview/lifecycle/) |
| Configure sleep, keep-alive, and ID normalization | [Sandbox options](https://developers.cloudflare.com/sandbox/configuration/sandbox-options/); omit removed session and transport fields on `@next`. |
| Create, connect, write to, resize, or stop interactive terminals | [Terminals API](https://developers.cloudflare.com/sandbox/1-0-preview/api/terminals/) and [Terminals](https://developers.cloudflare.com/sandbox/1-0-preview/terminals/) |
| Attach the interpreter, manage contexts, run code, or consume streamed results | [Interpreter](https://developers.cloudflare.com/sandbox/1-0-preview/interpreter/) and [Interpreter API](https://developers.cloudflare.com/sandbox/1-0-preview/api/interpreter/) |
| Set sandbox or per-launch environment | [Environment variables](https://developers.cloudflare.com/sandbox/1-0-preview/environment/) |
| Keep external API credentials in the Worker | [Outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/) |
| Handle startup failures, interrupted work, stale handles, or local wait cancellation | [Errors and recovery](https://developers.cloudflare.com/sandbox/1-0-preview/errors/) and [Errors API](https://developers.cloudflare.com/sandbox/1-0-preview/api/errors/) |
| Find other preview APIs | [Preview API reference](https://developers.cloudflare.com/sandbox/1-0-preview/api/) |

For files, mounts, backups, ports, and tunnels, follow the shared-surface links in the [preview overview](https://developers.cloudflare.com/sandbox/1-0-preview/). Use main-docs signatures only where that overview says they still apply; ignore stable-only session and transport options.
