# Secrets Store configuration

Fetch the guide for the operation you are performing before writing configuration or running management commands.

## Setup and management

| Task | Documentation |
|------|---------------|
| Create a store and secret, then bind it through Wrangler or the dashboard | [Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/) |
| Create, edit, duplicate, or delete account secrets | [Manage secrets](https://developers.cloudflare.com/secrets-store/manage-secrets/how-to/) |
| Look up current store/secret command syntax and local versus remote flags | [Wrangler Secrets Store commands](https://developers.cloudflare.com/workers/wrangler/commands/secrets-store/) |
| Configure bindings for each deployment environment | [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/) |
| Choose user roles, CI token permissions, and secret scopes | [Secrets Store access control](https://developers.cloudflare.com/secrets-store/access-control/) |

Treat the store ID, secret ID, secret name, and Worker binding name as different identifiers. Use the identifier required by the documented operation; do not infer update or delete flags from the create command.

## Local development and deployment

Secrets Store management commands default to local state; production operations use the documented remote option. Local development needs separately provisioned local secrets. Follow the local-development notes in [Workers integration](https://developers.cloudflare.com/secrets-store/integrations/workers/) and the [command reference](https://developers.cloudflare.com/workers/wrangler/commands/secrets-store/).

Check the selected account, deployment environment, secret scope, and binding configuration before deploying. In CI, distinguish permission to read metadata from permission to attach a secret to a Worker; use the [CI/CD access-control guidance](https://developers.cloudflare.com/secrets-store/access-control/#api-token-permissions).

Use protected secret input rather than putting credential values in command arguments, source files, or CI logs. For interactive CLI use, follow the command reference's secret-value prompt guidance. Keep local credentials out of version control.

See [api.md](./api.md) for runtime access and [patterns.md](./patterns.md) before replacing a shared credential.
