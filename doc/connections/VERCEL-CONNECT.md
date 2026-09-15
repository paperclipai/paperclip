# Vercel Connect credential source

Audience: Paperclip operators and engineers enabling Vercel Connect for outbound
remote MCP apps.

Vercel Connect is an optional credential authority inside Apps v2. Operators
create, attach, authorize, and inspect connectors in Vercel. Paperclip records
only the connector ID/UID and reviewed, redacted grant metadata, then requests a
short-lived provider token while listing or calling tools. Provider bearers do
not enter Paperclip secrets, connection config, agent config, prompts, API
responses, activity rows, or audit details.

This is an opt-in exception to the normal instance-vault custody rule, not a new
connection model. Profiles, policies, ask-first approvals, changed-tool
quarantine, resource filters, installs, and audit continue to use Apps v2.

> **Preview UI paused:** Paperclip currently withholds Vercel Connect from Apps
> Browse and redirects `/apps/vercel-connect` back to Apps. The persisted model,
> runtime resolver, and existing-connection management remain in place so saved
> references are not orphaned. New operator setup is intentionally unavailable
> until the integration is ready for another product review.

## Deployment configuration

Paperclip pins `@vercel/connect` to `0.6.1`.

| Setting | Meaning |
| --- | --- |
| `PAPERCLIP_VERCEL_CONNECT_ENABLED=true` | Enables the backend capability for controlled testing and existing connections. It does not currently expose a customer-facing setup entry. |
| `VERCEL_OIDC_TOKEN` | Workload identity injected by Vercel and preferred when present. |
| `PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN` | BYO instance bootstrap authority for deployments without Vercel workload OIDC. |
| `PAPERCLIP_INSTANCE_ID` | Included in derived pseudonymous user subjects when configured. |

The feature flag gates creation only. Existing Vercel-backed connections keep
resolving when the flag is later disabled, provided workload OIDC or the BYO
access token is still valid. Missing or invalid authority fails closed and a
health check marks the connection degraded. Page views never probe Vercel.

Treat `PAPERCLIP_VERCEL_CONNECT_ACCESS_TOKEN` like any other deployment
bootstrap secret: inject it through the host/container secret facility, rotate
it outside Paperclip, and never put it in `company_secrets`, app config, task
text, logs, or screenshots. A conventional Vercel personal access token is not
automatically Connect authority just because it has a long lifetime or broad
scope; validate the exact token type against `getConnectorMetadata` before
rollout. Paperclip prefers workload OIDC whenever both authorities are present,
so a stale fallback token cannot shadow a healthy workload identity.

For local development, link the checkout to the Vercel project and pull a fresh
workload token:

```sh
pnpm dlx vercel@latest link
pnpm dlx vercel@latest env pull .env.local
```

The downloaded OIDC token is intentionally short-lived. Pull it again when it
expires; do not extend or copy it into a year-long secret. On Vercel deployments,
the platform injects and refreshes workload identity automatically. Provider
tokens returned by Connect are also short-lived and are refreshed through the
normal SDK cache path rather than persisted by Paperclip.

## Operator setup (currently withheld from the product UI)

The following flow is retained as implementation and test documentation. It is
not available from Apps while the preview UI is paused.

1. Open [Vercel Connect](https://vercel.com/connect), create the provider
   connector, and attach it to the project/environments allowed to run
   Paperclip. Vercel remains the inventory and management UI.
2. In a future reviewed build, Paperclip will expose one isolated Vercel Connect
   setup entry. Native PostHog, Linear, Notion, and other provider setup screens
   will not show Vercel as a credential option. The retained pilot definitions
   cover PostHog, Linear, and Notion.
3. Choose the reviewed app, open the Vercel handoff if needed, and paste only
   the connector UID (for example `notion/paperclip`) or connector ID (`scl_…`).
4. Paperclip calls `getConnectorMetadata` and rejects missing, unattached, or
   wrong-service connectors. It does not copy Vercel's forms or arbitrary vendor
   metadata.
5. For a user OAuth connector, continue through Vercel authorization. The
   callback is one-time and bound to the company, actor, and board session. For
   app/API-key connectors, Paperclip verifies setup with a token request. If an
   installation is required, complete it in Vercel and retry; Paperclip does not
   use the experimental installation API.
6. Review the discovered catalog and complete the existing Paperclip access,
   resource-filter, risk, and agent-install steps.

V1 requires one dedicated app-subject connector per Paperclip connection. Do
not reuse an app-subject connector across Paperclip companies. Multi-installation
routing and shared app-subject connectors are intentionally deferred.

## Runtime and subject binding

Paperclip selects the effective connection grant before requesting a token. It
derives user-subject IDs from the Paperclip instance, company, connection, grant
kind, and responsible user. Organization OAuth uses a company-scoped
pseudonymous user subject; personal OAuth adds the Paperclip user. App/API-key
methods use Vercel's `app` subject. Neither browsers nor agents may supply these
subject identifiers.

Token resolution uses the SDK cache plus Paperclip single-flight deduplication.
Normal catalog refreshes and invocations use cached valid tokens. Setup,
explicit health checks, and the one retry following an upstream `401` force a
fresh request. The `401` retry first evicts the matching cache entry and never
loops.

Remote MCP requests include the canonical server URL as the OAuth resource
indicator (for example, `https://mcp.posthog.com/mcp`, without transport-only
query parameters). This binds consent and returned scopes to the reviewed MCP
service instead of accidentally receiving only generic identity scopes. For a
custom PostHog OAuth connector, configure a public client with token auth method
`none` and PKCE `S256`; Paperclip sends the canonical resource plus reviewed
`scopes: ["*"]`, allowing PostHog to select the MCP scopes for that resource.

The reviewed app definition controls the exact token scopes and header
placement. Paperclip injects the bearer only after the connection grant,
profile, policy, approval, resource filter, and catalog entry have been
selected. Stored grant metadata is limited to subject type, optional
installation/tenant IDs, token ID, expiry, and last verification time. The
pseudonymous subject ID is server-only and redacted from APIs.

## Recovery and removal

Stable Paperclip reason codes include:

| Code | Operator action |
| --- | --- |
| `vercel_connect_unavailable` | Restore workload OIDC or the BYO access token. |
| `vercel_connect_auth_failed` | Repair or refresh Paperclip's Vercel authority, and verify that the configured token type is accepted by Connect. |
| `vercel_connect_connector_not_found` | Attach the pasted connector to the correct Vercel project/environment. |
| `vercel_connect_authorization_required` | Reauthorize the responsible identity in Vercel Connect. |
| `vercel_connect_installation_required` | Complete the provider installation in Vercel, then run **Check again**. |
| `vercel_connect_request_failed` | Inspect Vercel status/audit and retry; upstream bodies remain redacted. |

Revocation or missing user authorization marks the grant
`needs_reauthorization` and blocks calls. When a responsible user is known,
Paperclip creates the existing authorization interaction. Reconnect UI sends
the operator to Vercel and an explicit health check; it never asks for a
provider key.

Removing an app disables local access and clears token caches before best-effort
external cleanup. Paperclip revokes subjects it generated for user-mode
connectors. App-subject connector cleanup remains in Vercel and is called out in
the removal receipt. Audit history remains available.

## Validation and rollout

Before enabling another app method, run the real-provider smoke matrix:

- create/attach the connector and validate its UID;
- discover the MCP catalog;
- run an allowed read;
- set a write to ask-first, then confirm it stops for approval and runs only after approval;
- revoke in Vercel and confirm the one retry fails closed;
- confirm the grant becomes `needs_reauthorization` and the audit trail contains
  no bearer, claims, bootstrap authority, or upstream response body;
- reconnect, run an explicit health check, and remove the connection.

CI uses a mocked Vercel-plus-MCP flow. Credentialed PostHog and Linear smoke is
an operator/release gate, not a repository secret fixture. Do not migrate
existing vault-backed connections automatically; source migration needs a later
atomic revoke-and-rollback workflow.

Vercel webhook triggers, generic REST/OpenAPI execution, connector inventory
synchronization, Paperclip-hosted relay services, and Vercel's experimental
installation API are outside V1.

Vercel bills Connect by token requests. Link operators to Vercel's live
[Connect page](https://vercel.com/connect) and [pricing documentation](https://vercel.com/docs/pricing)
instead of copying rates into Paperclip documentation.
