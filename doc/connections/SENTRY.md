# Sentry

Paperclip connects to Sentry's [official MCP server](https://mcp.sentry.dev/)
at `https://mcp.sentry.dev/mcp`. Browser sign-in uses the MCP authorization
server. A normal connection does not require a customer-created OAuth app.

## Discovery

The method pins the [MCP protected-resource metadata](https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp).
That document names `https://mcp.sentry.dev` as its authorization server.
Its [authorization-server metadata](https://mcp.sentry.dev/.well-known/oauth-authorization-server)
advertises automatic client registration, PKCE S256, refresh tokens, and
client ID metadata documents. Paperclip retains its normal client selection
and binding checks.

Do not use `https://sentry.io/.well-known/oauth-authorization-server` for this
method. That server describes the web/API OAuth service. It does not advertise
MCP client registration. Both metadata URLs return valid JSON, so checking
only HTTP status or the presence of authorization/token endpoints misses this
failure.

## Repair an existing connection

After deploying the corrected catalog, resume or reconnect the existing Sentry
connection. Keep its connection identity and access policies. Complete browser
consent if required. Confirm the intended organization and projects through a
read-only tool call from the assigned agent.

The catalog repair fixes setup and reconnect discovery. It cannot restore an
expired or revoked grant without the owner's consent. If the saved connection
changes to **Finish setup**, inspect its health error, refresh outcome, and
transition timestamp separately. A setup error alone does not prove why the
previous grant stopped working.

## Verification

The service regression uses separate, realistic metadata for both Sentry
hosts. It checks new registration and reuse of an existing MCP registration,
the authorization URL, resource, requested scopes, and PKCE. These fixtures
prove Paperclip's endpoint selection; they do not prove live account consent.

Before claiming restoration, verify browser consent, catalog discovery, and a
real agent read. Record token refresh separately. Do not publish credentials
or unredacted authorization URLs in evidence.
