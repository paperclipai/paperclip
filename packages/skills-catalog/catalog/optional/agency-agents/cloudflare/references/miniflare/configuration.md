# Miniflare Configuration

Direct Miniflare does not read Wrangler configuration. Configure its bindings explicitly and build TypeScript or bundled Workers before starting tests; see [writing tests](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/).

Match the Worker's intended compatibility date and flags when testing its behavior. Consult [compatibility dates](https://developers.cloudflare.com/workers/testing/miniflare/core/compatibility/) rather than substituting a fixed date from a sample.

| Configure | Documentation |
|-----------|---------------|
| Script source, HTTP server, request metadata, or reloading | [Get started](https://developers.cloudflare.com/workers/testing/miniflare/get-started/) |
| Module format and resolution rules | [Modules](https://developers.cloudflare.com/workers/testing/miniflare/core/modules/) |
| Values and file-backed bindings | [Variables and secrets](https://developers.cloudflare.com/workers/testing/miniflare/core/variables-secrets/) |
| Service bindings, shared storage, and several Workers | [Multiple Workers](https://developers.cloudflare.com/workers/testing/miniflare/core/multiple-workers/) |
| Storage bindings and documented persistence options | [KV](https://developers.cloudflare.com/workers/testing/miniflare/storage/kv/), [R2](https://developers.cloudflare.com/workers/testing/miniflare/storage/r2/), [D1](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/), [Durable Objects](https://developers.cloudflare.com/workers/testing/miniflare/storage/durable-objects/), [Cache](https://developers.cloudflare.com/workers/testing/miniflare/storage/cache/) |
| Queue producers and consumers | [Queues](https://developers.cloudflare.com/workers/testing/miniflare/core/queues/) |

If the task is to run tests from the project's build and Wrangler configuration, consider the [integration test harness](https://developers.cloudflare.com/workers/testing/test-harness/) or [Workers Vitest setup](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/).
