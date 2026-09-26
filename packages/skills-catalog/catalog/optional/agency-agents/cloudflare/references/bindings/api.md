# Bindings API Reference

Fetch the relevant documentation before choosing method signatures, binding types, or type-generation settings.

| Task | Current documentation |
| --- | --- |
| Access bindings in handlers, entrypoint classes, or imported `env` | [Bindings and environment access](https://developers.cloudflare.com/workers/runtime-apis/bindings/) |
| Generate environment and runtime types; configure TypeScript or migrate from `@cloudflare/workers-types` | [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |
| Use framework-specific environment access | [Hono on Workers](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/) (follow the framework's linked documentation) |
| Read, write, delete, and list KV keys | [KV Workers API](https://developers.cloudflare.com/kv/api/) |
| Read, write, delete, and list R2 objects | [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) |
| Prepare and bind SQL statements or execute batches | [D1 Workers Binding API](https://developers.cloudflare.com/d1/worker-api/) |
| Address Durable Objects and call their methods | [Durable Objects API](https://developers.cloudflare.com/durable-objects/api/) |
| Send queue messages | [Queues JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/) |
| Run model inference | [Workers AI bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/) |
| Call another Worker using HTTP or typed RPC | [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) and [RPC TypeScript](https://developers.cloudflare.com/workers/runtime-apis/rpc/typescript/) |
| Find other product binding APIs, including Browser, mTLS, rate limiting, and Workflows | [Current binding catalog](https://developers.cloudflare.com/workers/runtime-apis/bindings/) |

Regenerate types after configuration changes and use the selected environment's configuration. Follow the current TypeScript setup for the project's toolchain instead of hardcoding a generated declaration path or maintaining a handwritten binding interface. Types describe the expected bindings; they do not provision resources or prove the deployed environment is configured correctly.
