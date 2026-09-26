# Static Assets Binding API

Read the binding reference before implementing calls. Check the configured binding name and use the project's existing environment types.

| Task | Documentation |
|------|---------------|
| Forward a request or fetch a specific asset | [Runtime API reference](https://developers.cloudflare.com/workers/static-assets/binding/#runtime-api-reference) |
| Understand how binding requests apply HTML and fallback settings | [Binding fetch behavior](https://developers.cloudflare.com/workers/static-assets/binding/#runtime-api-reference) and [HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/) |
| Run authorization or transform content before serving | [Run your Worker script first](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/#run-your-worker-script-first) |
| Inspect default MIME, cache, and validation headers | [Default headers](https://developers.cloudflare.com/workers/static-assets/headers/#default-headers) |
| Add or override response headers | [Custom headers and Worker-response caveat](https://developers.cloudflare.com/workers/static-assets/headers/#custom-headers) |
| Fetch assets imported by Vite | [Vite asset features](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/#features) |

When selecting a different asset, construct a full URL using the incoming request as the base. Preserve the returned status and headers when transforming a response; do not collapse every unsuccessful response into an application 404.

See [configuration.md](configuration.md) for bindings and [patterns.md](patterns.md) for routing choices.
