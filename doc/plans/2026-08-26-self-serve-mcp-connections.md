# Self-Serve MCP Connections Program

Date: 2026-08-26

## Outcome

Paperclip treats a connection method as the capability boundary. A curated MCP method may declare automatic OAuth registration (`dcr`, including CIMD), a customer-owned OAuth client (`customer`), an API key, or a provider-generated MCP URL. Provider tokens and client secrets remain in the instance's encrypted vault. Paperclip ID remains the future broker for `platform_shared` registrations; the self-serve catalog does not depend on it.

The machine-readable evidence ledger is [`packages/shared/src/self-serve-mcp-research.json`](../../packages/shared/src/self-serve-mcp-research.json). It is the source for the generated app definitions and records the documentation URL, current endpoint, authentication mode, prerequisite, risk tier, and verification date for all 46 researched providers.

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
- [x] Show the instance-provided `availability.reason` for Gmail, Google Sheets, and any future instance-disabled app; remove “Coming soon” from the connectable catalog.
- [x] Ship 50 unique local provider marks under `ui/public/brands/apps/`, with no favicon proxy or generated provider imitation.
- [x] Record provider, local asset, official source, upstream asset, format, visibility, and dark-variant requirements in `ui/public/brands/apps/manifest.json`.
- [x] Preserve local light/dark branding paths through definition regeneration and validate every SVG/PNG during manifest tests.
- [x] Reuse `AppLogo` across Browse, setup, success, Connections, details, sidebars, and connection-intent cards; retain its deterministic letter tile only for runtime image failure.
- [x] Replace the compact method segment with full-row radio choices that name authentication, mode/region, and when to use each method.
- [x] Present warnings, prerequisites, and provider documentation before credentials or consent.
- [x] Prevent automatic OAuth from bypassing tenant/extension fields or the customer-owned OAuth alternative; ClickHouse must collect `serviceId`.
- [x] Default S4 write and destructive actions to ask-first while retaining Supabase's project-scoped read-only default.
- [x] Add an opt-in credential-free metadata preflight. It performs guarded GET requests only and never creates a connection or invokes OAuth registration.

## Provider rollout checklist

“Definition” means the reviewed manifest and UI/server setup contract are implemented. “Live proof” requires a provider account and must be completed before production enablement: authorize in a browser, list tools, run one safe read, refresh/reconnect, revoke, and inspect API responses and logs for secret leakage.

| Provider | Wave | Definition | Live proof | Notes |
|---|---:|:---:|:---:|---|
| Jira | 1 | [x] | [ ] | Reference DCR/CIMD flow; `https://mcp.atlassian.com/v1/mcp/authv2`. |
| Airtable | 1 | [x] | [ ] | Enterprise client allowlisting may apply. |
| beehiiv | 1 | [x] | [ ] | Plan controls write capabilities. |
| Bitly | 1 | [x] | [ ] | Browser sign-in and API-token methods. |
| Candid | 1 | [x] | [ ] | DCR. |
| Cloudflare | 1 | [x] | [ ] | Browser sign-in and API-token methods. |
| Cloudinary | 1 | [x] | [ ] | Current `/mcp` endpoint, not the captured SSE endpoint. |
| Coda | 1 | [x] | [ ] | Browser sign-in and personal token; beta warning. |
| Hugging Face | 1 | [x] | [ ] | DCR/CIMD. |
| Kernel | 1 | [x] | [ ] | Current `/mcp` endpoint; API-key alternative. |
| Local Falcon | 1 | [x] | [ ] | DCR. |
| Make | 1 | [x] | [ ] | DCR. |
| Manufact | 1 | [x] | [ ] | DCR. |
| Miro | 1 | [x] | [ ] | Enterprise client restrictions may apply. |
| Netlify | 1 | [x] | [ ] | DCR. |
| Notion | 1 | [x] | [ ] | Existing DCR definition hardened by scope containment. |
| O'Reilly | 1 | [x] | [ ] | Browser sign-in and token methods. |
| PlanetScale | 1 | [x] | [ ] | Database and insights-only methods; optional intended project/branch metadata. |
| PostHog | 1 | [x] | [ ] | OAuth and API-key methods retain project pinning. |
| Resend | 1 | [x] | [ ] | Current `/mcp` endpoint. |
| Sentry | 1 | [x] | [ ] | Existing DCR/CIMD definition enabled. |
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
| Supabase | 2 | [x] | [ ] | Project required, read-only default, optional feature groups, production-data warning. |
| Ticket Tailor | 2 | [x] | [ ] | Provider-hosted authorization may request an API key. |
| Asana | 3 | [x] | [ ] | Customer-owned OAuth app; DCR intentionally disabled. |
| Box | 3 | [x] | [ ] | Customer-owned OAuth app and Box admin prerequisite. |
| Mem0 | 3 | [x] | [ ] | Bearer API key. |
| PagerDuty | 3 | [x] | [ ] | API token; separate US and EU methods. |
| Similarweb | 3 | [x] | [ ] | `api-key` header and API-enabled subscription. |
| Xero | 3 | [x] | [ ] | Customer-owned OAuth app; confirm remote endpoint and data-use terms during live proof. |
| Zapier | 3 | [x] | [ ] | Existing generated-URL flow; never substitutes a static shared endpoint. |
| G2 | Blocked | [x] | n/a | Reconsider after a customer-created client works without G2 coordination. |
| Vercel | Blocked | [x] | n/a | Reconsider when reviewed-client approval is removed or Paperclip is approved. |
| Zomato | Blocked | [x] | n/a | Reconsider when third-party clients and unallowlisted redirect URIs are supported. |

## Automated acceptance

- [x] Manifest tests assert 46 researched entries, 43 self-serve candidates, three blocked providers, unique slugs, HTTPS documentation/endpoints, authentication mode, prerequisite, risk tier, and verification date.
- [x] Definition tests cover corrected endpoints, ClickHouse's service header, Postman's six modes, Supabase's read-only default, and customer-owned OAuth ownership.
- [x] Server tests cover DCR reuse, CIMD/DCR fixtures, customer OAuth secret storage, scope containment, token refresh/revocation, SSRF rejection, company isolation, and failed-setup cleanup.
- [x] UI tests cover automatic OAuth, customer-owned OAuth credentials, API keys, generated URLs, tenant fields, prerequisites, and unavailable-provider policy.
- [x] Branding tests require exactly 50 visible, unique, local, decodable marks and verify dark variants and the failed-image fallback.
- [x] Routing tests prove all 43 researched self-serve candidates are actionable and all three blocked providers remain absent.
- [x] Metadata preflight tests prove Jira discovery sends no credential, makes no registration request, and treats an authentication challenge as endpoint reachability.
- [x] `pnpm check:token-gates` is required for the UI change.
- [ ] Complete the account-bound live proof column above before declaring each provider production-verified.

## Remaining external verification

The code paths and catalog definitions are complete. The unchecked work is deliberately account-bound and cannot be inferred from public metadata alone:

1. Start with Jira, then complete Wave 1 automatic OAuth providers. For each provider: authorize, list tools, run one safe read, reconnect/refresh, revoke, and inspect API responses and server logs for secrets.
2. Validate customer-created OAuth applications end to end for Asana, Box, and Xero, including redirect URI configuration and tenant-admin prerequisites.
3. Validate restricted-key flows for Mem0, PagerDuty, Similarweb, and every API-key alternative; confirm the manifest's exact header/query placement.
4. Exercise all six Postman modes, both PagerDuty regions, PlanetScale database/insights modes, and Supabase's project-scoped read-only default against real accounts.
5. Confirm Xero's endpoint and applicable AI/data-use terms before marking it verified. Pilot Embat before removing its sparse-documentation warning.
6. Keep preview, paid-plan, early-access, and tenant-admin-gated providers connectable with their current warnings. These prerequisites do not change self-serve status.
7. Reconsider G2, Vercel, and Zomato only when their provider-approval constraints change; until then they remain absent from the catalog.

## Operating rules

- “Self-serve” allows normal accounts, subscriptions, tenant-admin policies, and OAuth consent, but excludes a Paperclip/provider partnership.
- Provider documentation and working live OAuth metadata are both required for production verification.
- Preview and early-access providers retain warnings until their live proof passes.
- This program covers hosted remote MCP connections and credential custody. Generic REST execution and Paperclip-ID-managed shared OAuth registrations remain separate follow-up programs.
