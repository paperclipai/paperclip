# Secrets Store troubleshooting

Start with the failing operation and fetch its documentation before changing credentials or bindings.

| Symptom or decision | What to check | Documentation |
|---------------------|---------------|---------------|
| Deployment cannot attach a secret | Selected account, caller's binding permission, and the secret's consuming-service scope; metadata read permission alone is insufficient | [Access control](https://developers.cloudflare.com/secrets-store/access-control/) |
| Secret is missing or the wrong value is used | Store, secret name, binding name, and selected deployment environment | [Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/), [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/) |
| Secret works in production but fails locally | Local secret provisioning and the management command's local/remote target | [Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/), [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/secrets-store/) |
| CLI update, retrieval, or deletion fails | The operation's required identifier and flags; a secret name is not interchangeable with its ID | [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/secrets-store/) |
| Binding is treated as a string or has incorrect types | Asynchronous account-secret access and generated configuration types | [Runtime access](https://developers.cloudflare.com/secrets-store/integrations/workers/#3-access-the-secret-on-the-env-object), [TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |
| Quota or value-size validation fails | Current account quota and the requested operation's schema | [Secrets Store REST API](https://developers.cloudflare.com/api/resources/secrets_store/) |
| Regional or integration support is unclear | Current product availability and supported consumers | [Product overview](https://developers.cloudflare.com/secrets-store/) |

Do not diagnose failures by printing secret values or returning raw errors to clients. Check metadata and sanitized operation context. Validate JSON or other structured values before consuming them, and handle retrieval or parsing failures at the application's error boundary.

Before deleting a secret to fix a binding conflict or quota problem, identify all consumers. Follow [secret management](https://developers.cloudflare.com/secrets-store/manage-secrets/how-to/) and the rotation decisions in [patterns.md](./patterns.md); removing a shared credential can affect multiple services.

See [configuration.md](./configuration.md) for setup and [api.md](./api.md) for API selection.
