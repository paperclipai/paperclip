# Errors and provider gotchas

Use this guide for failures shared by Composio For You and Composio Platform. Keep product-specific credential and client setup in the selected product guide.

## Start with evidence

Get the Composio log or request ID and inspect Dashboard Logs before changing credentials or code. Agent frameworks often wrap the underlying provider error.

When the CLI is already installed and authenticated for the applicable product, these commands can provide additional evidence:

```bash
composio dev logs tools
composio dev logs triggers
composio connections list
```

Do not install or reinitialize the CLI solely to diagnose a dashboard log that already contains the failure.

## Tool does not exist

Never guess a slug. In a Platform session, discover tools through the session meta tools. In a CLI workflow, use `composio search`, then inspect the returned tool.

For legacy manual execution, a missing tool may be a toolkit-version problem. Fetch current migration and execution docs rather than assuming the provider lacks the operation. New session integrations should use runtime discovery.

## Identify the authentication boundary

### Composio project or session 401

This happens before a provider tool call succeeds. The Platform project credential may be missing, masked, invalid, or associated with a different project.

Re-run the no-output credential checks from the Platform guide. Do not print, rotate, replace, or request the key in chat. If the developer arrived from Dashboard Getting Started, direct them back to that project's Step 1 rather than running `composio dev init`.

### Provider connected-account 401

This appears on a real tool execution after the project and session reached the provider. The selected user's provider token may be revoked, expired, or invalidated by a password, 2FA, consent, or administrator-policy change.

Keep the same project key and application user ID. Generate a fresh Connect Link for that integration, reconnect the provider account, and retry the safe call. If a link expired, request a new one.

### For You client authentication

If the MCP client itself cannot authenticate, verify the consumer endpoint, OAuth session, or `ck_...` header path from the For You guide. Do not substitute a Platform project key.

## Common provider constraints

- **Google "App is blocked":** remove unnecessary scopes or use a verified custom OAuth app.
- **Google API disabled:** enable the required provider API in the Google Cloud project that owns the custom credentials.
- **Slack 429:** managed apps share provider quota; use a custom Slack app for a dedicated bucket when needed.
- **Microsoft 403:** the tenant may require administrator consent.
- **GitHub App access:** OAuth credentials and repository installation are separate steps.
- **Payment toolkit session restriction:** treat it as a surface policy restriction, not a plan or connection failure.

## Branding and production auth

Managed auth is intended to make initial development easy. Before launch, move integrations that require the application's branding, scopes, or dedicated quotas onto its own OAuth apps.

When someone asks to remove Composio branding, identify the surface first: Connect Link page, provider consent screen, secured badge, callback domain, or success page. They have different fixes. Fetch `white-labeling-authentication.md` before proposing an implementation.

## Triggers and webhooks

Check the Composio status page and trigger logs before changing a trigger. Use current trigger documentation for event names, polling limits, and connection-state verification. Do not promise static outbound IPs; use documented webhook signature verification.

## Canonical follow-up

For provider- or toolkit-specific behavior, fetch:

```text
https://docs.composio.dev/toolkits/<toolkit>.md
```

For APIs, migrations, triggers, or compliance questions, find the current page through `https://docs.composio.dev/llms.txt`. If the problem remains unresolved, include the log ID when escalating to Composio support.
