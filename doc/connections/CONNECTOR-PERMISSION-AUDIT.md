# Tool connection permission audit — 2026-09-30

This review covers 117 tool methods (84 OAuth methods). The machine-readable
[source of reviewed defaults](./tool-method-permission-reviews.json) lists each
method's exact requested scopes, supported actions, restrictions, sources and
verification limits. AI runtime authentication and chat/channel setup are
separate contracts and were not changed.

Methods reviewed after this audit carry their own `reviewedAt` date in the same
ledger; the counts above are not restated. Later additions: [Neon](./NEON.md)
(`mcp-oauth`, `mcp-api-key`; 2026-10-02).

## Shared credential failure

Zapier's secret URL exposed a shared ownership/resolution problem. The same
invariants apply to personal pasted-key and custom-header methods, including
Bitly, Cloudflare, Coda, Fireflies, GitHub PATs, Kernel, O'Reilly, PagerDuty,
PostHog, Postman, Razorpay, Sanity, Similarweb, Stripe, Supabase and You.com.
Generic MCP setup uses this path too, so “Connect your own” was not a reliable
workaround. This is a code-path finding, not a claim that every provider was
tested with a live account.

Personal invocation secrets now belong to the grant's user. Setup, health,
discovery and the run gateway share ownership checks and canonical credential
paths. Public unauthenticated URLs need no credential repair. OAuth client
registration secrets remain company-owned and separate from invocation tokens.
Existing connections with incorrectly owned credentials require the owner to
reconnect with a fresh key or secret URL. There is no automatic ownership backfill.

## Changes

- Airtable now requests its seven documented record, schema, comment and
  workspace/base scopes, including writes.
- Explicit scope sets were added for providers that advertise a scoped MCP
  resource, including Beehiiv, Netlify, Miro, Sentry, Supabase, Todoist and
  TickTick. Read and write remain subject to provider roles and resource selection.
- Hugging Face adds repository read/contribution and jobs to `read-mcp`.
  Optional tools still need enabling in HF's MCP settings.
- Slack's reviewed set now covers the documented message, channel, reaction,
  canvas, file and list actions. It replaces the obsolete generic search scope
  with the documented search scopes. The fixed app/approval gate remains.
- Google write/draft methods take priority over managed read-only methods when
  available. Existing Google profiles, preview verification and availability
  gates remain. People and Workspace Search stay read-only.
- The hosted Fireflies server also exposes meeting sharing, renaming, moving and
  soundbite creation. Its identity scopes are retained; meeting ownership and
  team roles decide which mutations succeed.
- Provider read-only choices stay available under Advanced. Existing OAuth
  tokens and action restrictions are untouched. Permissions offers reconnect
  when provider consent needs changing.

## Provider-default exceptions

These are deliberate exceptions to supplying `scopesHint`, not claims that an
old grant can write. Several servers put resource/permission selection in their
own consent screen; Box uses registered app scopes, and managed GitHub uses
installation permissions. An authorization server's general scope catalog is
not a safe substitute for the MCP permission contract.

| Provider / method | Reason and limits |
| --- | --- |
| bitly / `mcp-oauth` | The official MCP quickstart uses browser authorization without client-selected scopes; neither protected-resource nor authorization-server metadata advertises a scope list. Bitly account permissions govern link actions. [Evidence](https://dev.bitly.com/bitly-mcp/overview/quickstart/) |
| box / `mcp-own-oauth` | Box requires scopes (including Manage AI) on the registered Box app in the Admin Console. Its MCP authorization metadata has no request-scope list; consent and the app registration control file operations. [Evidence](https://support.box.com/hc/en-us/articles/43847256139923-Managing-Box-MCP-Servers) |
| egnyte / `mcp-oauth` | The hosted authorization server selects the Egnyte tenant/account permissions. Neither MCP nor authorization-server metadata advertises request scopes. Documentation rendered no readable body during this review; tenant-bound write proof remains required. [Evidence](https://developers.egnyte.com/docs/Remote_MCP_Server) |
| github / `managed` | Managed github.code uses a GitHub App installation and selected repositories. Installation permissions, not OAuth scope strings, grant code and pull-request writes; retain the managed profile. [Evidence](https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/) |
| make / `mcp-oauth` | Make documents selecting scopes and scenarios during its hosted connection flow. Management tools require a paid plan. Do not replace that resource selection with invented MCP client scopes. [Evidence](https://developers.make.com/mcp-server) |
| oauth-generic / `oauth` | Operator-defined OAuth endpoints have no provider-specific reviewed scope list. Request only the scopes supplied by the operator; this template is not a curated provider allowlist. [Evidence](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) |
| planetscale / `mcp-oauth` | PlanetScale documents choosing organizations, databases and read/write permission at authorization. Its general authorization server advertises unrelated organization administration too; retain the provider consent selection, and the separate insights-only endpoint. [Evidence](https://planetscale.com/docs/connect/mcp) |
| planetscale / `mcp-insights-only` | PlanetScale documents choosing organizations, databases and read/write permission at authorization. Its general authorization server advertises unrelated organization administration too; retain the provider consent selection, and the separate insights-only endpoint. [Evidence](https://planetscale.com/docs/connect/mcp) |
| posthog / `mcp-oauth` | PostHog documents the no-scope MCP setup as read/write, with optional readonly and feature filters. The authorization server advertises account administration unrelated to many tools; retain its MCP consent defaults and the existing explicit filters. [Evidence](https://posthog.com/docs/model-context-protocol) |
| postman / `mcp-oauth-minimal` | The official remote MCP setup uses browser sign-in and endpoint-selected minimal/code/full tool catalogs. Its protected-resource and authorization-server metadata publish no scope set; account/workspace rights govern writes. [Evidence](https://learning.postman.com/latest-v-12/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server) |
| postman / `mcp-oauth-code` | The official remote MCP setup uses browser sign-in and endpoint-selected minimal/code/full tool catalogs. Its protected-resource and authorization-server metadata publish no scope set; account/workspace rights govern writes. [Evidence](https://learning.postman.com/latest-v-12/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server) |
| postman / `mcp-oauth-full` | The official remote MCP setup uses browser sign-in and endpoint-selected minimal/code/full tool catalogs. Its protected-resource and authorization-server metadata publish no scope set; account/workspace rights govern writes. [Evidence](https://learning.postman.com/latest-v-12/docs/reference/postman-api/postman-mcp-server/postman-mcp-remote-server) |
| razorpay / `mcp-oauth` | Neither protected-resource nor authorization-server metadata advertises scopes. Keep hosted provider consent; the previous official OAuth documentation URL returned 404 during review. Account-bound writes need live confirmation. [Evidence](https://razorpay.com/docs/mcp-server/oauth/) |
| ticket-tailor / `mcp-oauth` | Hosted authorization controls box-office API-key permissions; do not treat OAuth sign-in as increasing the underlying key permissions. This method requires account-bound proof. [Evidence](https://developers.tickettailor.com/docs/mcp/authentication/) |
| webflow / `mcp-oauth` | The official MCP setup installs the Bridge App and asks users to authorize sites. Neither protected-resource nor authorization-server metadata publishes a request-scope list; the installed app and site selection govern writes. [Evidence](https://developers.webflow.com/mcp/reference/getting-started) |

## Read-only and provider-controlled methods

Candid, Context7, O'Reilly, Similarweb and You.com expose retrieval/research
capabilities rather than document/account mutation. PlanetScale's insights-only
endpoint deliberately excludes query execution. Xero's current published MCP
scope set includes invoice/report reads and settings access, without invoice
write permission. Do not widen these using unrelated general API scopes.

Scopes such as `openid`, `global`, `mcp:all` or `workspace:member` do not have to
contain the word “write” to authorize work. The provider's MCP tool contract,
role and consent selection determine their meaning. In particular, Cloudflare,
Vercel, Wix, Kernel and Supermemory retain their provider-side permission gates.

## Evidence and verification boundaries

Official docs and unauthenticated protected-resource/authorization metadata were
retrieved on 2026-09-30. The review records source URLs per method. Some pages
(especially Egnyte and Razorpay's old OAuth URL) were unavailable or unreadable;
those entries explicitly retain that limitation. Embat publishes identity
metadata but no verified write contract. No account-bound write guarantee is
made for these entries.

No provider account was used for live read/write verification in this task.
In particular, public scope metadata is **not** proof that an existing token has
those permissions or that an account has the required paid plan, resource ACLs,
admin approval, or Google preview enrollment. Use test accounts/resources for
that proof before claiming provider-level acceptance.

Backend regressions execute catalog Zapier, generic secret URLs, personal
bearer/custom headers, organization credentials and public URLs through the
run-scoped gateway using a fixture transport. They assert canonical persisted
ownership/declarations and run read and write calls. Reconnect regressions cover
replacing legacy company credentials with user-owned values and declarations.
OAuth fixtures assert exact authorization scopes and rejection of an unrelated
advertised admin scope; they do not contact provider accounts.

The managed worktree has a separate instance configuration and database path.
Local CLI provisioning was attempted with both minimal and full seed modes;
both failed while applying the copied database's migrations because
`tool_connections_transport_check` was missing. The development instance was
not started from that clone. Clean fixture databases were used for the backend and Apps browser
checks; their success does not establish successful seeding of that local copy.

### Embedded-browser acceptance

On 2026-09-30, a hands-on walkthrough used the PR checkout's built UI and actual
server, a fresh isolated database created through CLI onboarding, and a local
HTTP MCP fixture. Starting from the sidebar's Connectors page, the operator
selected “Just me,” entered a bearer key, and created and read back a disposable
widget through the Permissions screen's agent test controls.

After seeding the legacy ownership mismatch in that disposable connection,
invocation and catalog refresh rejected it with `grant_credential_invalid`.
The catalog showed “Needs attention” and offered Reconnect. Replacing the key
through that UI preserved the connection and personal grant, created a fresh
user-owned secret and canonical declaration, and restored writes. The legacy
company secret retained its ownership. Separate HTTP calls through a session
bound to a fixture agent run also completed a write and read-back.

The walkthrough exposed and verified fixes for a false “Still not working”
message after successful reconnect, incorrect action-input advice for ownership
errors, and Cancel attempting to save an invalid Zapier URL. The browser
reconnect regression now performs the replacement through the form and checks
that the stale warning disappears.

A second personal connection used a secret URL. After reproducing its legacy
ownership failure, the browser could replace the URL and create/read back a
widget. Generic reconnect now derives URL/header fields from the stored
credential placement instead of assuming a bearer key, and rejects replacement
URLs for a different public endpoint. A new public, organization-wide connection
also appeared immediately when returning to Browse, without a page reload.
The walkthrough fixed setup cache invalidation and a cramped reconnect banner.

Zapier's URL validation and cancellation were exercised, but a live Zapier
connection was not completed. Gmail stopped at instance enrollment. Neither
journey establishes provider-account consent or live provider read/write proof.

### Automated verification

- Run `pnpm -r typecheck`, `pnpm build`, and `pnpm check:token-gates`.
- The affected Apps browser suites passed 10 tests, with one existing restart
  case skipped. These used clean, isolated fixture databases.
- Run `pnpm test:run` for the full suite. Current-head CI and local results are
  recorded in the pull request; fixture coverage is distinct from provider proof.
- New gateway fixtures execute both read and write calls through real run-scoped
  gateway sessions. They also verify that invalid ownership requires reconnect
  and that the owner's fresh credentials restore access without changing identity.
