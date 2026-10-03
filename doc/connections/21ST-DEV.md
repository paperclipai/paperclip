# 21st Dev

Built-in catalog entry for the hosted 21st MCP. Uses the existing remote MCP
setup, vault, discovery, grants, policy, audit and revocation paths.

## Setup

Open Apps, select **21st Dev**, choose agent access, and connect with a fresh
API key created at https://21st.dev/mcp. Paperclip sends the key in `x-api-key`
to `https://21st.dev/api/mcp`; the key is stored through the existing connection
credential writer. Keys from the retired Magic console no longer work.

Search and component retrieval depend on the account's entitlements. Hosted
AI generation requires AI access and credits. Check `get_usage.aiGenerationEnabled`
before generating; this reports access, not the remaining credit balance. Refresh
tools or reconnect after enabling AI. Do not retry `ai_subscription_required`
through legacy aliases. Available tools are discovered from the authenticated
account; the connector does not hard-code the legacy Magic tool inventory.

## Research and branding evidence — 2026-10-03

- Official setup: https://github.com/21st-dev/magic-mcp/blob/main/README.md
  and https://github.com/21st-dev/magic-mcp/blob/main/llms-install.md.
- Product and key console: https://21st.dev/mcp.
- An unauthenticated MCP initialization POST returned HTTP 401 with JSON-RPC
  error -32001 and fresh-key guidance. No credential was submitted.
- The response advertised MCP protocol `2025-06-18` and
  `WWW-Authenticate: Bearer resource_metadata="https://21st.dev/.well-known/oauth-protected-resource/api/mcp"`.
- Protected-resource metadata identifies `https://21st.dev/api/mcp`,
  `https://clerk.21st.dev`, and identity scopes `openid`, `profile`, `email`.
  This entry uses the documented API-key method; it does not initiate OAuth,
  register clients, or request identity scopes.
- Artwork: https://21st.dev/logo-icon.svg, linked from the official product
  homepage, copied with SVG attribute names normalized to `ui/public/brands/apps/21st-dev.svg`. The blue vendor mark
  uses a 400×400 viewBox and no external references or executable content.
  The same artwork serves both themes inside Paperclip's existing icon frame.
- Brand aliases: 21st, 21st.dev, Magic MCP.

## Acceptance and evidence limits

The catalog must expose one remote MCP API-key method with the exact endpoint,
custom header, vaulted password field, key-console link, and entitlement guidance.
Existing generic setup must preserve credential ownership, discovery, governance,
refresh/reconnect and revocation semantics. Manifest and branding regression
checks cover the curated entry; no provider-specific runtime code is added.

Account-bound qualification remains outstanding: connect with a real account,
inspect vaulted secret ownership/declarations and redaction, discover tools, run
one safe search and an authorized reversible write through a run-scoped gateway,
refresh/reconnect, revoke, and confirm calls are blocked and audit rows recorded.
No API key was available during implementation. Public metadata and fixture tests
are not live provider proof. Do not describe this entry as production-qualified
until those checks pass.
