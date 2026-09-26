# Secrets Store APIs

Fetch the current API documentation before implementing calls or copying types.

| Task | Documentation |
|------|---------------|
| Read a bound account secret asynchronously in a Worker | [Workers integration: access the secret](https://developers.cloudflare.com/secrets-store/integrations/workers/#3-access-the-secret-on-the-env-object) |
| Generate binding and runtime types for the Worker configuration | [Workers TypeScript](https://developers.cloudflare.com/workers/languages/typescript/) |
| Manage stores and secrets, inspect metadata, or query quota | [Secrets Store REST API](https://developers.cloudflare.com/api/resources/secrets_store/) |
| Choose authorization and consuming-service scope | [Access control](https://developers.cloudflare.com/secrets-store/access-control/) |
| Manage secrets through the CLI instead of REST | [Wrangler Secrets Store commands](https://developers.cloudflare.com/workers/wrangler/commands/secrets-store/) |

## Runtime decisions

Account-secret bindings require asynchronous retrieval; they are not the direct string values exposed by [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/). Account management APIs and metadata reads are separate from consuming a bound secret in a Worker.

Handle retrieval failures at the application's error boundary without exposing credentials. Reuse a retrieved value within the request when useful; avoid long-lived application caches that could keep revoked credentials in use. Validate structured secret values against the application's schema before using them.

Never return a credential to a client or include it in logs, error messages, or telemetry. Record only the non-sensitive context needed to diagnose a failure.

See [configuration.md](./configuration.md) for setup and [gotchas.md](./gotchas.md) for access failures.
