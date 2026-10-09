# Hosted MCP qualification — 2026-10-09

This batch continues the verified connector work in [PR #15621](https://github.com/paperclipai/paperclip/pull/15621). Provider research was checked against the existing paperclip-content integration research and the canonical [connector playbook](CONNECTOR-PLAYBOOK.md). Luna workers researched and exercised separate providers in an isolated local Paperclip company.

## Completed browser journeys

| Provider / method | Setup | Discovered actions | Bounded UI Test | Persistence |
| --- | --- | --- | --- | --- |
| Bitly / OAuth | New account and `mcp.all` explicitly approved; HTTPS DCR/OAuth | 56: 30 read, 26 write | `bitly_get_user`, 2.0s; returned profile values omitted | Reload and catalog refresh retained 56 actions, Just me, zero selected agents, all writes Off |
| Context7 / public MCP | No account, key, or OAuth | 2 read, 0 write | Resolve React → `/reactjs/react.dev`, 2.9s; useEffect cleanup documentation query, 3.0s | Repeat query after reload passed in 3.1s; zero selected agents retained |
| Hugging Face / public MCP | No account, key, or OAuth; existing OAuth method retained separately | 4 read, 0 write | `hf_fs` public documentation search, 0.7s | Exact same query passed after reload in 0.8s; 4 actions and zero selected agents retained |
| Resend / OAuth | Team grant `full_access` explicitly approved; HTTPS DCR/OAuth | 132: 55 read, 77 write | `List Domains` at 4.3s and 0.9s; final fresh setup after the access-marker refinement passed in 1.4s; one entry each, values omitted | Fresh setup/reload retained Just me and zero agents; all actions Off in final reloaded state |

Tests used the actual Apps setup and Permissions Test dialog. The built-in Connector Tester was the test actor; no real agent adapter, task, or runtime was started. Discovery and read proof do not establish write behavior, token-refresh rotation, or every advertised action.

Bitly's older recovery connection was left with all 56 actions Off. Resend's three older qualification connections were also left all Off. Provider-wide OAuth grants still exist; local action policies govern execution separately. No email was sent, link created, destructive provider action executed, purchase made, or paid job started.

For Resend, an earlier bulk-Off change was not reflected after a reload. Its historical cause is unresolved. A controlled Off → Ask first → reload → Off → reload check, waiting for the visible Saving indicator to clear before each reload, preserved both settled values. No policy persistence defect was reproduced. Qualification records the final persisted state, not an assumed explanation for that earlier observation.

## Incomplete providers

These definitions and durable overrides are retained for further work, but withheld as new Browse candidates. Existing installed/incomplete connections remain visible for recovery. They are not claimed as live-qualified.

| Provider | Observed gate | Next concrete step |
| --- | --- | --- |
| monday.com | Registration HTTP 400: `redirect_uris are not allowed: please contact monday to add the redirect URIs to the allowlist` | Obtain provider approval for the HTTPS callback. Account-admin approval may also apply after registration. No grant or account read occurred. |
| ClickUp | Both retained and fresh Google identity flows returned to blank ClickUp login with `Password required` | Resolve the ClickUp account/login route, then review its `read write` provider consent and run a bounded workspace read. No grant or authenticated catalog occurred. |
| Klaviyo | Initial client authorization reached; no account or exact scope strings enumerated; optional prompt-intent collection unchecked | Await the separate client authorization decision, then review any subsequent account/scope grant. No approval, account read, campaign send, or deletion occurred. |

The saved monday.com draft was resumed from Browse and survived reload in the actual app after the recovery fix. Fresh `source=monday` setup stayed withheld, and using the same draft with `source=clickup` showed a provider-mismatch error. These checks did not retry authorization or approve a provider grant. An extra public Context7 connection was seeded as a saved draft through the local API solely to exercise recovery. Browse → Finish setup → Connect reached the success screen after activation, with zero agents selected; the saved Connected state and zero-agent choice survived a Permissions reload. Refreshing the generated `stage=complete` URL now opens that exact saved Permissions page after validating active status, company, application, and provider. View connection also opens that exact page. A normal active recovery URL and a completed URL with a mismatched provider stayed blocked in the browser; a draft at the completion stage does not imply success.

monday.com is recorded as provider-approval blocked in the research ledger. ClickUp and Klaviyo retain their documented DCR setup research but remain hidden pending actual qualification.

## Shared fixes found during real use

- Token exchange now requests `Accept: application/json`. Bitly documents a legacy form response when this header is absent. The first callback reported `oauth_access_token_missing`; a fresh equivalent authorization succeeded after the header fix. The earlier token response body/content type was not captured, so the exact old payload remains unproven. Code exchange and refresh use the same exchange function.
- Remote MCP callbacks preserve an explicitly saved Access step, including zero selected agents. Saving installs now records a transactional marker, distinguishing a deliberate empty selection from a flow that has not selected access. The old branch only recognized aggregator MCP methods, causing fresh Resend setup to replace an empty install set with access for all agents. Empty, individual-agent, company, and unconfigured-default selections have regression coverage for install rows and profile bindings. Managed OAuth keeps its subject/recommended defaults when no Access choice was saved.

- Saved hidden-provider drafts now reach their exact setup wizard from Finish setup. The wizard validates the company-visible draft, its application, and matching provider before resolving a hidden definition; unknown or mismatched drafts stay on an error screen. Fresh hidden-provider setup remains withheld. Completion now accepts the exact active row only after this flow successfully finishes it, so the draft → active refetch preserves the success screen; normal initially active, disabled, archived, and mismatched recovery URLs remain rejected.

Provider-specific changes use durable overrides so ingestion preserves them. Bitly and Resend use full documented account capabilities; Context7 and Hugging Face add or qualify public read endpoints. No custom skills or channels are required for these basic MCP tool connections.

## Permission and public-read screenshots

![Bitly: zero agents selected, write actions Off](easy-mcp-batch-2-evidence-2026-10-09/bitly-permissions.jpg)

![Context7: successful public documentation read](easy-mcp-batch-2-evidence-2026-10-09/context7-read.jpg)

![Hugging Face: four read actions and zero selected agents](easy-mcp-batch-2-evidence-2026-10-09/hugging-face-permissions.jpg)

![Resend: all actions Off after read qualification](easy-mcp-batch-2-evidence-2026-10-09/resend-permissions.jpg)

![monday.com: retained draft reaches its setup wizard; provider approval remains blocked](easy-mcp-batch-2-evidence-2026-10-09/monday-draft-resume.jpg)

![Context7: resumed public setup survives activation and reaches success with zero agents](easy-mcp-batch-2-evidence-2026-10-09/context7-resumed-completion.jpg)

![Context7: completed URL restores the exact saved permissions page with zero agents](easy-mcp-batch-2-evidence-2026-10-09/context7-completed-route.jpg)

## Evidence and sources

Account-profile and domain results remain private and are not committed. Permission screenshots and public documentation results can be shared after visual review. Provider-specific `liveProof` and `evidenceLimit` records are in [tool-method-permission-reviews.json](tool-method-permission-reviews.json); the dated research entries are in [self-serve-mcp-research.json](../../packages/shared/src/self-serve-mcp-research.json).

- [Bitly hosted MCP quickstart](https://dev.bitly.com/bitly-mcp/overview/quickstart/) and [token response format](https://dev.bitly.com/docs/getting-started/authentication/).
- [Context7 API guide](https://context7.com/docs/api-guide) and [official MCP source](https://github.com/upstash/context7/blob/master/packages/mcp/src/index.ts).
- [Resend remote MCP](https://resend.com/changelog/remote-mcp-server).
- [monday.com MCP integration](https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp).
- [ClickUp MCP](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server).
- [Klaviyo MCP](https://developers.klaviyo.com/en/docs/connect_to_the_klaviyo_mcp_server).
- [Hugging Face MCP](https://huggingface.co/docs/hub/agents-mcp) and [official server](https://github.com/huggingface/hf-mcp-server).

## Validation

- Shared catalog suite: 36 passed.
- Durable override suite: 3 passed.
- Focused UI setup, recovery, Browse, and OAuth-helper suites: 306 passed.
- Brand validation: 101 identities passed.
- Full connector service suite: 420 passed, including the four-case JSON-token/access regression and existing managed OAuth lifecycle coverage.
- Recursive typecheck: passed again after rebasing onto current master.
- Recursive production build: passed again after rebasing onto current master. UI typecheck, production build, and token gates passed again after the draft-recovery fix.
- Full local repository Vitest was started before the rebase and cancelled as superseded while still in the general-server phase. It is not counted as a completed pass. Broad current-head verification is tracked in [PR #15686 checks](https://github.com/paperclipai/paperclip/pull/15686/checks); the complete connector service suite passed separately against the final production code.

The local host reached its macOS System V shared-memory limit during a service restart. Only stale, unattached user-owned segments with dead creator/operator processes were reclaimed; other running apps and their databases were left intact. This host resource failure is separate from provider login/approval gates.
