# Self-Serve MCP Connections Program

Date: 2026-08-26

## Outcome

Paperclip treats a connection method as the capability boundary. A curated MCP method may declare automatic OAuth registration (`dcr`, including CIMD), a customer-owned OAuth client (`customer`), an API key, or a provider-generated MCP URL. Provider tokens and client secrets remain in the instance's encrypted vault. Paperclip ID remains the future broker for `platform_shared` registrations; the self-serve catalog does not depend on it.

The machine-readable evidence ledger is [`packages/shared/src/self-serve-mcp-research.json`](../../packages/shared/src/self-serve-mcp-research.json). It is the source for the generated app definitions and records the documentation URL, current endpoint, authentication mode, prerequisite, risk tier, and verification date for all 46 researched providers.

Store visibility is a separate release gate from having an implemented definition. As of 2026-08-27, Browse exposes 29 providers. The following definitions remain available to existing saved connections and the verification program but are withheld from Browse, new source deep links, and agent connection suggestions until they are ready:

- Pending live testing: beehiiv, Bitly, Candid, Kernel, Coda, Local Falcon, Make, Manufact, O'Reilly, PlanetScale, TickTick, Brex, Egnyte, Embat, Razorpay, Sanity, Ticket Tailor, Google Sheets, Context7, and Similarweb.
- Reserved for future first-party connection experiences: GitHub and Slack.

## Platform checklist

- [x] Replace the Notion-only OAuth allowlist with app-definition capability checks.
- [x] Support DCR/CIMD browser sign-in for curated remote MCP methods.
- [x] Accept customer-owned OAuth client IDs and secrets only when a method declares `customer` ownership.
- [x] Store customer OAuth secrets and provider tokens as encrypted secret references, never inline in connection configuration or API responses.
- [x] Keep Paperclip ID limited to explicitly brokered `platform_shared` methods such as Gmail.
- [x] Contain curated OAuth scopes to the method's reviewed `scopesHint`; omit scope when the method has no hint and reject caller widening.
- [x] Reuse the existing connection setup flow for browser sign-in, customer OAuth apps, API keys, tenant fields, and generated URLs.
- [x] Correct the Jira, Cloudinary, Kernel, Resend, ClickHouse, Postman, PagerDuty, Supabase, PlanetScale, and Zapier connection shapes.
- [x] Keep G2, Vercel, and Zomato out of the connectable catalog while retaining their evidence and reconsideration criteria.

## Catalog delivery and branding checklist

- [x] Derive Browse, setup, reconnect, and additional-account routes from method capabilities instead of a slug switch.
- [x] Route automatic OAuth, customer OAuth, API-key, and no-auth methods through `/apps/connect?source=<slug>`; retain Zapier's provider-generated URL path.
- [x] Show the instance-provided `availability.reason` for Gmail and any future instance-disabled store app; remove “Coming soon” from the connectable catalog.
- [x] Retain vetted local provider marks under `ui/public/brands/apps/` for every implemented definition, including providers currently withheld from Browse.
- [x] Record provider, local asset, official source, upstream asset, format, visibility, and dark-variant requirements in `ui/public/brands/apps/manifest.json`.
- [x] Preserve local light/dark branding paths through definition regeneration and validate every SVG/PNG during manifest tests.
- [x] Reuse `AppLogo` across Browse, setup, success, Connections, details, sidebars, and connection-intent cards; retain its deterministic letter tile only for runtime image failure.
- [x] Replace the compact method segment with full-row radio choices that name authentication, mode/region, and when to use each method.
- [x] Present warnings, prerequisites, and provider documentation before credentials or consent.
- [x] Prevent automatic OAuth from bypassing tenant/extension fields or the customer-owned OAuth alternative; ClickHouse must collect `serviceId`.
- [x] Default every discovered action to On, with S4 write and destructive actions governed by ask-first; Supabase remains project-scoped but starts write-capable.
- [x] Add an opt-in credential-free metadata preflight. It performs guarded GET requests only and never creates a connection or invokes OAuth registration.

## Provider rollout checklist

“Definition” means the reviewed manifest and UI/server setup contract are implemented. “Live proof” requires a provider account and must be completed before production enablement: authorize in a browser, list tools, run one safe read, refresh/reconnect, revoke, and inspect API responses and logs for secret leakage.

| Provider | Wave | Definition | Live proof | Notes |
|---|---:|:---:|:---:|---|
| Jira | 1 | [x] | [ ] | Reference DCR/CIMD flow; `https://mcp.atlassian.com/v1/mcp/authv2`. On 2026-08-27, browser authorization, 26-tool discovery, tenant lookup, a safe project read, JQL search, and reconnect passed against `paperclipteam.atlassian.net`; revocation remains pending because the working connection was retained. Atlassian's `/authv2` rollout requires the reviewed protected-resource scope set to be sent explicitly before consent. |
| Airtable | 1 | [x] | [ ] | Enterprise client allowlisting may apply. On 2026-08-27, browser authorization was limited to the single `Untitled Base`, tool discovery succeeded, and `List Airtable bases` returned that base through Paperclip; reconnect/revoke and the final log audit remain pending. |
| beehiiv | 1 | [x] | [ ] | Plan controls write capabilities. |
| Bitly | 1 | [x] | [ ] | Browser sign-in and API-token methods. |
| Candid | 1 | [x] | [ ] | DCR. |
| Cloudflare | 1 | [x] | [ ] | Browser sign-in and API-token methods. |
| Cloudinary | 1 | [x] | [ ] | Current `/mcp` endpoint, not the captured SSE endpoint. On 2026-08-27, browser authorization against cloud `z4nrpggk`, tool discovery, and the safe `get-usage-details` read succeeded; reconnect/revoke and the final log audit remain pending. |
| Coda | 1 | [x] | [ ] | Browser sign-in and personal token; beta warning. |
| Hugging Face | 1 | [x] | [ ] | DCR/CIMD. On 2026-08-27, browser authorization completed with only the reviewed `read-mcp` scope and no organization grant, five tools were discovered, and `Hugging Face User Info` succeeded without returning the token value; reconnect/revoke and the final log audit remain pending. |
| Kernel | 1 | [x] | [ ] | Current `/mcp` endpoint; API-key alternative. |
| Local Falcon | 1 | [x] | [ ] | DCR. |
| Make | 1 | [x] | [ ] | DCR. |
| Manufact | 1 | [x] | [ ] | DCR. |
| Miro | 1 | [x] | [ ] | Enterprise client restrictions may apply. On 2026-08-27, the first live exchange found that Paperclip overrode Miro's advertised DCR client-auth order and selected `client_secret_basic`; preserving the provider's `client_secret_post` preference fixed the exchange. Reauthorization, 60-tool discovery, and `Who Am I` then succeeded; reconnect/revoke and the final log audit remain pending. |
| Netlify | 1 | [x] | [ ] | DCR. On 2026-08-27, the saved draft resumed through Netlify consent, nine tools were discovered, and the safe `get-user` read succeeded. The public connection response exposed only a vault secret reference, not the access token; reconnect/refresh, revoke, and the final log audit remain pending. |
| Notion | 1 | [x] | [ ] | Existing DCR definition hardened by scope containment. |
| O'Reilly | 1 | [x] | [ ] | Browser sign-in and token methods. |
| PlanetScale | 1 | [x] | [ ] | Database and insights-only methods; optional intended project/branch metadata. |
| PostHog | 1 | [x] | [ ] | OAuth and API-key methods support optional advanced project pinning; the recommended OAuth path requires no project ID. |
| Resend | 1 | [x] | [ ] | Current `/mcp` endpoint. |
| Sentry | 1 | [x] | [ ] | Existing DCR/CIMD definition enabled. On 2026-08-27, browser authorization, seven-tool discovery, and the safe `find_organizations` read succeeded against `paperclip-5s`. Sentry intentionally disables its upstream `Approve` control until one second after the first pointer or keyboard interaction; live-test automation must satisfy that guard before treating the provider as blocked. The public connection response exposed only a vault secret reference, not the access token; reconnect/refresh, revoke, and the final log audit remain pending. |
| TickTick | 1 | [x] | [ ] | DCR. |
| Todoist | 1 | [x] | [ ] | DCR. |
| Webflow | 1 | [x] | [ ] | Tenant roles constrain site access. |
| Wix | 1 | [x] | [ ] | DCR. |
| Brex | 2 | [x] | [ ] | Early access/admin prerequisite; S4 warning. |
| ClickHouse | 2 | [x] | [ ] | `/clickstack`; required `x-service-id` header. |
| Egnyte | 2 | [x] | [ ] | Plan and external-LLM admin prerequisites. |
| Embat | 2 | [x] | [ ] | WorkOS DCR/CIMD; pilot because documentation is sparse. |
| Mixpanel | 2 | [x] | [ ] | Beta warning. |
| Postman | 2 | [x] | [ ] | US OAuth and EU API-key methods for minimal/code/full endpoints. |
| Razorpay | 2 | [x] | [ ] | OAuth and key method; S4 financial warning. |
| Sanity | 2 | [x] | [ ] | Browser sign-in and token methods. |
| Stripe | 2 | [x] | [ ] | OAuth and key method; public-preview/S4 warning. |
| Supabase | 2 | [x] | [ ] | Project required, write-capable default, optional feature groups, production-data warning. |
| Ticket Tailor | 2 | [x] | [ ] | Provider-hosted authorization may request an API key. |
| Asana | 3 | [x] | [ ] | Customer-owned OAuth app; DCR intentionally disabled. |
| Box | 3 | [x] | [ ] | Customer-owned OAuth app and Box admin prerequisite. |
| Mem0 | 3 | [x] | [ ] | Bearer API key. |
| PagerDuty | 3 | [x] | [ ] | API token; separate US and EU methods. |
| Similarweb | 3 | [x] | [ ] | `api-key` header and API-enabled subscription. |
| Xero | 3 | [x] | Withheld | Browser OAuth and refresh tokens succeeded on 2026-08-27, but `mcp.xero.com/mcp` rejected the valid third-party access token with HTTP 401. Withheld from Browse pending Xero support for customer-created OAuth clients on the hosted endpoint; this matches the unresolved report in [Xero's MCP repository](https://github.com/xeroapi/xero-mcp-server/issues/212). |
| Zapier | 3 | [x] | [ ] | Existing generated-URL flow; never substitutes a static shared endpoint. |
| G2 | Blocked | [x] | n/a | Reconsider after a customer-created client works without G2 coordination. |
| Vercel | Blocked | [x] | n/a | Reconsider when reviewed-client approval is removed or Paperclip is approved. |
| Zomato | Blocked | [x] | n/a | Reconsider when third-party clients and unallowlisted redirect URIs are supported. |

## Browser authorization redirect audit

This is a local, credential-free handoff check performed through the real BOB catalog UI on 2026-08-26. A checked provider reached its own login, consent, domain-picker, or authorization page. It does **not** satisfy the account-bound live-proof column above, which still requires consent, tool discovery, a safe read, reconnect/refresh, revocation, and secret-leak inspection.

- [x] Jira, Airtable, beehiiv, Bitly, Candid, Cloudflare, Cloudinary, Coda, Hugging Face, Kernel, Local Falcon, Make, Manufact, Miro, Netlify, Notion, O'Reilly, PlanetScale, PostHog, Resend, Sentry, TickTick, Todoist, Webflow, and Wix.
- [x] ClickHouse, Egnyte, Embat, Mixpanel, Postman, Razorpay, Sanity, Stripe, Supabase, and Ticket Tailor.
- [ ] Brex — the documented `https://api.brex.com/mcp` endpoint did not return discovery or challenge data from this development environment before the guarded network timeout. Brex also requires Developer API access plus its admin/early-access setup. Re-run after those account prerequisites are enabled; do not treat the current timeout as an OAuth compatibility result.
- [ ] Gmail — intentionally unavailable on this instance because its Paperclip ID connector is not configured; Browse shows the instance-provided configuration notice instead of starting OAuth.

The audit found and fixed shared interoperability faults rather than adding provider exceptions: bounded provider-added DCR grants, RFC 7591 zero secret-expiry sentinels for public clients, authorization servers that explicitly omit refresh-token support, guarded HTTP requests that require a stable User-Agent, and numeric-loopback callbacks rejected by DCR servers. Hugging Face now explicitly requests only `read-mcp` instead of allowing the provider's omitted-scope default to request its complete scope set.

## Automated acceptance

- [x] Manifest tests assert 46 researched entries, 43 self-serve candidates, three blocked providers, unique slugs, HTTPS documentation/endpoints, authentication mode, prerequisite, risk tier, and verification date.
- [x] Definition tests cover corrected endpoints, ClickHouse's service header, Postman's six modes, Supabase's write-capable default, and customer-owned OAuth ownership.
- [x] Server tests cover DCR reuse, CIMD/DCR fixtures, customer OAuth secret storage, scope containment, token refresh/revocation, SSRF rejection, company isolation, and failed-setup cleanup.
- [x] UI tests cover automatic OAuth, customer-owned OAuth credentials, API keys, generated URLs, tenant fields, prerequisites, and unavailable-provider policy.
- [x] Branding tests require exactly 29 store-visible, unique, local, decodable marks and preserve provenance for withheld definitions.
- [x] Routing tests prove all 29 store-visible providers are actionable, all 22 release-gated providers remain absent, and all three blocked providers remain absent.
- [x] Metadata preflight tests prove Jira discovery sends no credential, makes no registration request, and treats an authentication challenge as endpoint reachability.
- [x] Browser handoff checks reach provider authorization for 35 of 37 automatic-OAuth catalog entries; Brex and instance-disabled Gmail remain explicitly tracked above.
- [x] `pnpm check:token-gates` is required for the UI change.
- [ ] Complete the account-bound live proof column above before declaring each provider production-verified.

## Remaining external verification

The code paths and catalog definitions are complete. The unchecked work is deliberately account-bound and cannot be inferred from public metadata alone:

1. Start with Jira, then complete Wave 1 automatic OAuth providers. For each provider: authorize, list tools, run one safe read, reconnect/refresh, revoke, and inspect API responses and server logs for secrets.
2. Validate customer-created OAuth applications end to end for Asana, Box, and Xero, including redirect URI configuration and tenant-admin prerequisites.
3. Validate restricted-key flows for Mem0, PagerDuty, Similarweb, and every API-key alternative; confirm the manifest's exact header/query placement.
4. Exercise all six Postman modes, both PagerDuty regions, PlanetScale database/insights modes, and Supabase's project-scoped write-capable default against real accounts.
5. Re-test Xero only after Xero confirms that its hosted MCP endpoint accepts customer-created OAuth clients; the 2026-08-27 live proof completed consent/token exchange but the endpoint returned HTTP 401. Pilot Embat before removing its sparse-documentation warning.
6. Keep preview, paid-plan, early-access, and tenant-admin-gated providers connectable with their current warnings. These prerequisites do not change self-serve status.
7. Reconsider G2, Vercel, and Zomato only when their provider-approval constraints change; until then they remain absent from the catalog.

## Operating rules

- “Self-serve” allows normal accounts, subscriptions, tenant-admin policies, and OAuth consent, but excludes a Paperclip/provider partnership.
- Provider documentation and working live OAuth metadata are both required for production verification.
- Preview and early-access providers retain warnings until their live proof passes.
- This program covers hosted remote MCP connections and credential custody. Generic REST execution and Paperclip-ID-managed shared OAuth registrations remain separate follow-up programs.
