# Workers Platform API Checks

Use the project's installed and generated types to check affected handlers and bindings. Consult current Cloudflare docs when API or runtime compatibility remains uncertain.

- [Type validation](#type-validation): binding types, handler signatures, and platform classes
- [Serialization boundaries](#serialization-boundaries): encoding and supported values for each API

## Type Validation

### Env interface

- Every binding must have a specific type. Flag `any`, `unknown`, `object`, or `Record<string, unknown>` on bindings.
- Binding types that accept generic parameters (Durable Object namespaces, Queues, Service bindings for RPC) must include them. Read the type definition to confirm which types are generic.
- Use the project's generated binding types; see [configuration guidance](configuration.md#generate-binding-types-with-wrangler-types).

### Handler and class signatures

Verify affected signatures against the project's target type definitions; consult current docs if runtime support or compatibility remains uncertain.

- Correct import path (most Workers platform classes import from `"cloudflare:workers"`)
- Generic type parameter on base classes (e.g., `DurableObject<Env>`)
- `ExecutionContext` as the third param in module export handlers (needed for `ctx.waitUntil()`)
- `fetch()` handlers must return `Promise<Response>`

### Binding access — the most common error

- **Module export handlers** (`fetch`, `scheduled`, `queue`, `email`): bindings via `env.X` parameter
- **Platform base classes** (`WorkerEntrypoint`, `DurableObject`, `Workflow`, `Agent`): bindings via `this.env.X`

Flag `env.X` inside a class extending a platform base class. Flag `this.env.X` inside a module export handler.

### Stale class patterns

Old patterns survive in codebases long after APIs change.

- **`extends` vs `implements`**: platform classes use `extends`, not `implements`. The `implements` pattern is legacy and loses `this.ctx`, `this.env`.
- **Import paths**: verify module specifiers match what types actually export. Common mistake: wrong path for `"cloudflare:workers"` vs `"cloudflare:workflows"`.
- **Renamed properties**: e.g., `this.state` to `this.ctx` in Durable Objects. Search types to confirm.
- **Constructor signatures**: base class constructors change. Verify expected parameters.

## Serialization Boundaries

Check the API and encoding at each boundary. Structured clone support does not imply JSON compatibility or SQL parameter support.

| Boundary | What to check |
|----------|---------------|
| [Queue messages](https://developers.cloudflare.com/queues/configuration/javascript-apis/#queuescontenttype) | Match the body to `contentType`: `json` requires JSON-compatible data, `text` a string, `bytes` an `ArrayBuffer`, and `v8` supports structured-clone values such as `Map` and `Date`. Check the configured compatibility date when relying on the default encoding. |
| [Workflow step results](https://developers.cloudflare.com/workflows/build/workers-api/) | Verify the step result against the documented serialization contract and the project's Workflow types before flagging a value. |
| [Durable Object KV storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#put-1) | `storage.put()` supports structured-clone values; do not apply a blanket ban on `Map` or `Set`. |
| [Durable Object SQL](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec) | Check bound parameters against the SQL API's supported types. Encode objects explicitly for the intended column representation. |
| [WebSocket messages](https://developers.cloudflare.com/workers/runtime-apis/websockets/#send) | Use `send()` with a string, `ArrayBuffer`, or `ArrayBufferView`; encode objects, for example with `JSON.stringify()`. |
