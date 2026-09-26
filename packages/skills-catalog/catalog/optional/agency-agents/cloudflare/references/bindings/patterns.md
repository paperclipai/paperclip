# Binding Patterns

Choose the interaction and lifecycle first, then retrieve the implementation guide.

| Task | Current documentation |
| --- | --- |
| Choose HTTP forwarding or RPC between Workers | [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/) |
| Forward Requests and Responses through a service binding | [Service bindings over HTTP](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/) |
| Expose callable methods with `WorkerEntrypoint` | [Service bindings over RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/) and [RPC TypeScript](https://developers.cloudflare.com/workers/runtime-apis/rpc/typescript/) |
| Run connected Workers during development | [Developing with multiple Workers](https://developers.cloudflare.com/workers/local-development/multi-workers/) |
| Test handlers against configured bindings and mock dependencies | [Workers Vitest configuration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/) and [test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/) |
| Select KV, D1, R2, or Durable Objects | [Storage options](https://developers.cloudflare.com/workers/platform/storage-options/) |
| Keep clients current when bindings change | [Binding lifecycle](https://developers.cloudflare.com/workers/runtime-apis/bindings/#making-changes-to-bindings) |
| Manage credentials used by external API clients | [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) |

Use service bindings for internal Worker calls when appropriate, and choose HTTP or RPC based on the interface being exposed. A service binding does not replace application-level authorization for the caller's requested operation.

Choose storage based on access patterns and consistency requirements, not copied size or latency thresholds. Parallelize independent binding operations when useful; preserve ordering where one operation depends on another's result.

Avoid retaining clients derived from mutable bindings across requests without accounting for binding updates. Importing `env` is supported, but binding I/O still requires an appropriate execution context; follow the lifecycle guide rather than assuming all global access is forbidden.
