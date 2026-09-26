# KV Configuration

Read the setup guide for the target environment before creating resources or editing bindings.

| Task | Documentation |
|------|---------------|
| Create a namespace and connect a Worker | [Get started](https://developers.cloudflare.com/kv/get-started/) and [KV bindings](https://developers.cloudflare.com/kv/concepts/kv-bindings/) |
| Configure staging and production namespaces | [KV environments](https://developers.cloudflare.com/kv/reference/environments/) |
| Generate Worker environment and binding types | [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |
| Develop against local storage or a remote binding | [KV local development](https://developers.cloudflare.com/kv/concepts/kv-bindings/) and [remote bindings](https://developers.cloudflare.com/workers/local-development/#remote-bindings) |
| Manage namespaces, individual keys, and bulk files from the CLI | [Wrangler KV commands](https://developers.cloudflare.com/kv/reference/kv-commands/) |
| Manage KV from another service or SDK | [KV REST API](https://developers.cloudflare.com/api/resources/kv/) |

Choose the namespace, account, and environment deliberately. Local KV data is separate from remote data; a remote binding accesses the selected Cloudflare namespace even when Worker code runs locally. Check the command's local/remote options and environment selection before seeding or inspecting data. A separate preview namespace is not required simply to use local KV.

Use generated types for binding shapes. JSON type annotations do not validate stored data at runtime; validate application data when its source or schema requires it.
