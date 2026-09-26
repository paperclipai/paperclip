# Pages Functions APIs

Fetch the API reference before writing a handler; keep runtime types and examples in their authoritative documentation.

| Task | Documentation |
| --- | --- |
| Choose method handlers and access EventContext | [API reference](https://developers.cloudflare.com/pages/functions/api-reference/) |
| Read parameters and resolve dynamic routes | [Routing](https://developers.cloudflare.com/pages/functions/routing/) |
| Compose middleware and continue a request | [Middleware](https://developers.cloudflare.com/pages/functions/middleware/) |
| Use a supported resource binding | [Bindings](https://developers.cloudflare.com/pages/functions/bindings/) |
| Handle requests through generated Worker output | [Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) |

Decide which handler owns the response, where shared state is established, and which paths should fall through to assets. The API reference also covers asynchronous work and asset fetching. See [configuration.md](./configuration.md) for binding setup and [patterns.md](./patterns.md) for request design.
