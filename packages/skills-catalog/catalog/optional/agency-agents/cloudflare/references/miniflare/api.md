# Miniflare API

Use the current documentation for method signatures and examples:

| Task | Documentation |
|------|---------------|
| Create, reload, or dispose an instance; wait for its HTTP server | [Get started](https://developers.cloudflare.com/workers/testing/miniflare/get-started/) |
| Dispatch requests and supply request metadata | [Fetch events](https://developers.cloudflare.com/workers/testing/miniflare/core/fetch/) |
| Trigger queue and scheduled handlers programmatically | [Dispatching events](https://developers.cloudflare.com/workers/testing/miniflare/get-started/#dispatching-events) |
| Configure queue producers and consumers | [Queues](https://developers.cloudflare.com/workers/testing/miniflare/core/queues/) |
| Trigger scheduled events over HTTP or the API | [Scheduled events](https://developers.cloudflare.com/workers/testing/miniflare/core/scheduled/) |
| Access bindings from tests | [Interacting with bindings](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/#interacting-with-bindings) |
| Access local storage | [KV](https://developers.cloudflare.com/workers/testing/miniflare/storage/kv/), [R2](https://developers.cloudflare.com/workers/testing/miniflare/storage/r2/), [D1](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/), [Durable Objects](https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/), [Cache](https://developers.cloudflare.com/workers/testing/miniflare/storage/cache/) |
| Handle a WebSocket upgrade in a test | [WebSockets](https://developers.cloudflare.com/workers/testing/miniflare/core/web-sockets/) |

For constructor options, read [configuration.md](./configuration.md). For runtime-specific test helpers, read [patterns.md](./patterns.md).
