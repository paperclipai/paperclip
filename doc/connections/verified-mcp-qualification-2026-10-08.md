# Verified MCP connectors — 2026-10-08

This change includes eleven providers with successful bounded reads through
Paperclip's real browser action tester. Seven are new catalog entries: Calendly,
Exa, Firecrawl, GSC Wizard, Parallel Search, Tavily, and Windsor.ai. Airtable,
Linear, Make, and PostHog already have catalog entries. AgentMail uses the
existing full integration; this change adds no AgentMail method or channel.

| Provider | Live read | Catalog and reload proof | Write policy during qualification |
|---|---|---|---|
| Airtable | Bounded base-name search, 0.6s | 46 actions; persisted after reload | All 22 writes Off; grant limited to one test base |
| Calendly | Current user, 2.5s | 36 actions; persisted after reload | All 11 writes Off |
| Exa | Public search found the official repository | Reload and refresh passed | No write call |
| Firecrawl | Public site scrape, HTTP 200, 0.6s | Connected with three actions; reload/refresh passed | No write call |
| GSC Wizard | Account, property list, seven-day performance summary, 1.1s | 112 actions; persisted after reload | All 32 writes Off; one selected property read |
| Linear | List teams, 0.3s | 68 actions; persisted after reload | All 30 writes Off |
| Make | Organization/team metadata | 133 actions; persisted after reload | All 59 writes Off |
| Parallel Search | Public search found the official repository | Reload and refresh passed | No write call |
| PostHog | Current user, 0.7s | 380 actions; persisted after reload | All seven writes Off; provider read-only preset |
| Tavily | Public search returned five results, 1.7s | Five read actions; persisted after reload | No write actions discovered |
| Windsor.ai | Source fields and bounded five-day Search Console data, 1.5s | 19 actions; persisted after reload | All five writes Off; Google source read-only |

The catalog keeps documented read/write capabilities. The test policy above
records the qualification settings; it does not change normal catalog defaults
or prove provider write behavior. Alternative documented auth methods were not
independently live-tested. No provider writes or actual agent sessions ran.
Several test-company installations report Any agent because scoped-agent
selection is unavailable; no agent runtime was started. Windsor used no agents.

Airtable requires reviewed DCR registration because its advertised CIMD flow
failed live. Calendly requires a compatible client name. Tavily's search passed
after proactive MCP initialization; two earlier HTTP 400 failures remain
undiagnosed. Calls are never automatically replayed. Firecrawl exposed an
optional nested-object form validation issue, which is fixed in the shared form.
The setup UI now displays the callback supplied by the server for HTTPS hosts.

GSC Wizard's resumed tab was already Connected before the worker continued.
The Google identity screen showed name/profile/email only; underlying Google
Search Console scopes were not independently verified. Provider metadata reports
paid/trial access of unknown provisioning provenance; no payment was made.
Airtable's worker submitted an expanded grant before revised action-time review.
The exact access and error were disclosed, and the user directed continuation
with the requested one-base grant. This procedural error is retained in the
qualification record; no subsequent grant expansion or provider write occurred.

[Machine-readable proof](verified-mcp-qualification-2026-10-08.json) and
[brand provenance](verified-mcp-brand-provenance-2026-10-08.json) record the scope.
Private account identifiers, credentials, OAuth state/codes, and returned metrics
are omitted. The original research and unfinished providers are preserved on a
separate local checkpoint branch and are outside this PR.

Repository validation is recorded in the PR description after checks complete.
Browser proof establishes these reads, not expiry refresh, provider writes, or
execution through an actual agent adapter.

## PR UI retest

The PR checkout UI was previewed on a separate loopback port against the existing, authorized local qualification server. This retest covers frontend behavior; it is not a new live proof of the revised server OAuth recovery path. Calendly appeared connected in the catalog and its setup screen displayed before authorization. The Firecrawl scrape tester succeeded after expanding More options, entering only the public `https://paperclip.ing` URL, and leaving nested optional inputs untouched. No new provider authorization or agent heartbeat was started.

- [Calendly catalog](verified-mcp-qualification-2026-10-08/calendly-catalog.jpg)
- [Calendly setup before authorization](verified-mcp-qualification-2026-10-08/calendly-setup.jpg)
- [Firecrawl successful read](verified-mcp-qualification-2026-10-08/firecrawl-read.jpg)

OAuth recovery now refreshes credentials after an upstream 401 and returns `oauth_refreshed_retry_required` without replaying the tool call. The caller must retry explicitly; that invocation creates a session with refreshed credentials when required. The regression test verifies single dispatch on each invocation and fresh session/protocol headers on explicit retry. This behavior also applies to the existing managed and Vercel OAuth gateway paths.
