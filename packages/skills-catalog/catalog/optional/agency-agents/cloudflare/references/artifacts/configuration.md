# Artifacts Configuration

## Worker Binding

Configure the `artifacts` binding in your Wrangler config:

```toml
[[artifacts]]
binding = "ARTIFACTS"
namespace = "default"
```

This exposes Artifacts on `env.ARTIFACTS` inside your Worker.

If you authenticate with `wrangler login`, current docs say Wrangler requests `artifacts:write` by default.

## TypeScript

Regenerate Worker types after adding the binding:

```bash
npx wrangler types
```

Use the generated binding type in your environment definition:

```typescript
interface Env {
  ARTIFACTS: Artifacts;
}
```

Wrangler generates the `Artifacts` type from the binding. Treat the generated `worker-configuration.d.ts` file as the source of truth for your environment.

## Structure Repos for Isolation

Artifacts works best when autonomous work is isolated:
- Create one repo per agent, session, sandbox, or task when work should stay separate.
- Fork from a reviewed baseline instead of copying starter files into every new repo.
- Use branches only when collaborators share the same lifecycle and need to work in one repo.
- Use namespaces to separate environments, teams, or high-rate workloads.

## REST Configuration

For external systems, configure the namespace-scoped base URL and gateway JWT:

```bash
export ARTIFACTS_NAMESPACE="default"
export ARTIFACTS_JWT="<YOUR_GATEWAY_JWT>"
export ARTIFACTS_BASE_URL="https://artifacts.cloudflare.net/v1/api/namespaces/$ARTIFACTS_NAMESPACE"
```

Some environments also expose an `/edge/v1/api/...` base path. Verify the correct host and base path in the live docs for your Artifacts environment.

Use environment variables or your secret manager. Do not hardcode gateway JWTs or repo tokens.

## Repo Tokens

Artifacts workflows usually involve repo-scoped tokens returned by `create()` or minted later through the binding or REST API.

Keep the control plane and data plane separate:
- Use the **Workers binding** or **REST API** with a gateway JWT to create repos and mint tokens.
- Use repo-scoped tokens only for **Git operations** against the returned `remote`.

Recommended handling:
- Mint the narrowest scope you need: `read` or `write`
- Prefer short-lived tokens for handoff between systems
- Revoke tokens that are no longer needed

Verify the current token behavior and auth guidance in `https://developers.cloudflare.com/artifacts/` before building long-lived automation.

## Git Consumers

Artifacts is designed to work with standard git-over-HTTPS clients once you have a repo `remote` and an access token.

Prefer header-based auth for local tooling so the full token stays out of the remote URL:

```bash
git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" clone "$ARTIFACTS_REMOTE" artifacts-clone
```

Use a Basic-auth remote only for short-lived commands that need a self-contained URL.

## Retrieval Checklist

Check the live docs before relying on:
- the current Workers binding surface
- exact token formats
- availability or product status
- route details for import, fork, and token-management flows
- the correct control-plane host or `/edge/v1` base path for your environment
- platform limits or pricing
