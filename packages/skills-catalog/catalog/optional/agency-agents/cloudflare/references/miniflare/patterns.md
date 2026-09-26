# Miniflare Testing Patterns

Choose the test runtime before adapting an example. With direct Miniflare, the Worker runs in workerd while the test runner runs in Node.js; importing Worker functions into Node.js can change runtime-dependent behavior. See [writing tests](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/).

| Task | Documentation |
|------|---------------|
| Write unit tests in the Workers runtime | [Workers Vitest setup](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/) |
| Use event, Durable Object, or other runtime test helpers | [Vitest test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/) |
| Test built Workers from an external runner | [Integration test harness](https://developers.cloudflare.com/workers/testing/test-harness/) |
| Build a custom runner with direct simulator control | [Miniflare writing tests](https://developers.cloudflare.com/workers/testing/miniflare/writing-tests/) |
| Access emulated bindings from Node.js | [getPlatformProxy](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy) |
| Mock outbound requests in Workers Vitest tests | [Mock outbound requests](https://developers.cloudflare.com/workers/testing/vitest-integration/mock-outbound-requests/) |
| Understand Vitest runtime isolation and concurrency | [Isolation and concurrency](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/) |
| Simulate inter-Worker calls and substitute services | [Multiple Workers](https://developers.cloudflare.com/workers/testing/miniflare/core/multiple-workers/) |
| Test WebSockets or access local storage | [API routing](./api.md) |

`getPlatformProxy` is for Node.js callers. The Workers Vitest runtime modules require tests running in the Workers runtime; they are not a substitute for calling `getPlatformProxy` in a Node.js test.

For direct Miniflare, clean up instances after tests using the documented [lifecycle](https://developers.cloudflare.com/workers/testing/miniflare/get-started/#watching-reloading-and-disposing). Choose persistence deliberately so tests do not inherit unintended state.
