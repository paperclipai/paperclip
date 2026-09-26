# Pages Functions Troubleshooting

Start with the request path, deployment environment, and generated output that actually handled the request.

| Task | Documentation |
| --- | --- |
| A Function does not run or receives unexpected parameters | [Routing](https://developers.cloudflare.com/pages/functions/routing/) |
| Middleware is skipped or static fallback fails | [Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) |
| Middleware order or scope is incorrect | [Middleware](https://developers.cloudflare.com/pages/functions/middleware/) |
| Bindings or secrets differ between environments | [Bindings](https://developers.cloudflare.com/pages/functions/bindings/) |
| Runtime or environment types do not match | [TypeScript](https://developers.cloudflare.com/pages/functions/typescript/) |
| A local request behaves differently | [Local development](https://developers.cloudflare.com/pages/functions/local-development/) |
| Inspect exceptions and deployment logs | [Debugging and logging](https://developers.cloudflare.com/pages/functions/debugging-and-logging/) |
| Check runtime quotas | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Check request costs | [Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/) |

Reproduce a failing path through the actual application rather than only calling a handler with a hand-built context. Check the deployed configuration and generated output before changing application code. See [Pages troubleshooting](../pages/gotchas.md) for build, asset, and framework issues.
