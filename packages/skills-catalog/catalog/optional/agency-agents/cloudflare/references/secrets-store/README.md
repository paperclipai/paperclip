# Cloudflare Secrets Store

Use Secrets Store for account-level credentials shared across Workers or supported integrations. Use [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/) when credentials belong to one Worker and do not need centralized sharing.

Fetch the relevant documentation before implementing. Current Cloudflare docs are the source of truth for binding APIs, management commands, permissions, availability, and quotas. Use the [Secrets Store documentation index](https://developers.cloudflare.com/secrets-store/llms.txt) to discover additional guidance.

## Choose the scope

- Share a secret only among services that should use the same credential and rotate together.
- Separate development, staging, and production credentials; select the intended account and environment before managing or binding a secret.
- Grant only the management permissions and consuming-service scopes needed. Permission to view metadata does not imply permission to bind or retrieve a value; fetch [access control](https://developers.cloudflare.com/secrets-store/access-control/) for the current rules.

## Read by task

| Task | Reference |
|------|-----------|
| Create secrets, configure bindings, or prepare local development | [configuration.md](./configuration.md) |
| Read a secret in a Worker or automate management | [api.md](./api.md) |
| Plan rotation, migration, encryption, or auditing | [patterns.md](./patterns.md) |
| Diagnose access, deployment, or quota failures | [gotchas.md](./gotchas.md) |

Fetch the [product overview](https://developers.cloudflare.com/secrets-store/) for current availability and supported integrations. For AI Gateway provider credentials, use [Bring your own keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).
