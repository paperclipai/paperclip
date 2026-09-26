# Pages Request Handling

Use the current Pages API and the project framework guide rather than translating a generic Worker example into Pages.

| Task | Documentation |
| --- | --- |
| Implement handlers and use context or asset fallback | [Functions API reference](https://developers.cloudflare.com/pages/functions/api-reference/) |
| Resolve dynamic paths and invocation routes | [Routing](https://developers.cloudflare.com/pages/functions/routing/) |
| Apply shared request logic | [Middleware](https://developers.cloudflare.com/pages/functions/middleware/) |
| Understand framework-generated Worker output | [Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) |
| Find the guide for the existing framework | [Framework guides](https://developers.cloudflare.com/pages/framework-guides/) |

First identify whether routing comes from the Functions directory or generated advanced-mode output. See [Pages Functions APIs](../pages-functions/api.md) for focused handler tasks and [patterns.md](./patterns.md) for migration decisions.
