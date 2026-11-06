# Connection search

`connections_search` accepts a service name or a natural-language query up to
4,000 characters. It ranks names before capabilities, tolerates extra words,
split names such as “Agent Mail,” and single-character spelling errors or
transpositions. Short partial names work too. Capability searches return
overlapping matches without requiring every query word to occur in the catalog.
Results are bounded to 40 entries. Exact app names outrank typo matches for
different apps (for example, Motion is not replaced by Notion). Query preparation
is shared across the catalog scan.

Discovery includes tool, channel/email, and AI methods. Channel methods follow
the instance's Chat connectors experimental setting. Each catalog method names
its `purpose`. Channel and AI methods include a company-scoped `setupPath` to
their existing setup flow. AgentMail also supports `connection_request`: it
creates an inline API-key card addressed to the responsible user. Search guidance
prefers this card over a setup link or asking for credentials in chat. Other
channel methods continue to use their setup path.

The AgentMail card grants company-wide human access and installs access only for
the requesting agent. It saves the credential, provisions or connects an inbox,
and completes only after the server verifies that the assigned inbox is usable.
A saved key alone does not make the search result ready. Partial setup can resume
after reload using the same request ID, without duplicating the account or inbox.

The agent chooses the relevant match using descriptions and method purposes.
It should clarify only when the task remains ambiguous. A search match does not
prove that an account is authorized, that a tool is installed, or that a provider
can perform every requested action.

## Aggregator discovery

The local support index combines reviewed Arcade/Zapier claims with the public
[Composio toolkit catalog](https://docs.composio.dev/toolkits). The Composio
snapshot includes names and toolkit identifiers, a source URL, and a verification
date. Each result links to its official toolkit page. This covers, for example,
[Circleback MCP](https://docs.composio.dev/toolkits/circleback_mcp), including
queries such as “help me find tools for circle back.”

Refresh the snapshot from the official public page with:

```sh
node scripts/update-composio-search-catalog.mjs
```

The script also accepts a saved HTML file as its first argument for reproducible
extraction. Review the resulting diff before committing it. Searches use this
local snapshot and authorized indexed tool namespaces; they do not send user
queries to a provider. Broad provider descriptions are not evidence of support.
Configured connection metadata remains scoped to the current company and
identity. Archived and unauthorized catalogs cannot establish an aggregator route.

Built-in connections remain preferred for the same app. Existing AI access is
checked through the agent's AI binding and credential selection. An aggregator route still requires a
saved provider choice or a verified explicit user request. Fuzzy retrieval never
grants consent. A provider connection is not proof that its underlying app is
authorized. Multiple matching aggregator apps are returned as candidates; the
agent searches the selected `aggregator.targetService` to get its provider question.

A fuzzy or partial external app match remains a suggestion alongside authorized
installed capability matches. It cannot replace those matches with a mandatory
provider question. For example, a query for a page service can return the
installed page tools alongside a Page X suggestion; selecting the exact Page X
service is required before that external route asks for provider consent.

## Regression coverage

```sh
pnpm exec vitest run packages/shared/src/connection-search.test.ts packages/shared/src/connection-routing.test.ts packages/shared/src/validators/connection-intent.test.ts server/src/__tests__/connection-aggregator-fallback.test.ts server/src/__tests__/connection-intents-service.test.ts
```

The database suite covers the original AgentMail sentence, split names, typos,
capability overlap, multiple services, AI discovery, experimental gating,
Circleback/Attio/ClickUp, indexed Executor tools, and provider consent. The native
tool authority test searches a paragraph longer than the old 200-character limit
and then creates a real connection interaction. Existing tests retain checks for
private metadata, administrative denials, stale identities, and saved declines.

When `connection_request` rejects an unknown `toolNames` entry, its error includes
up to twenty exact names from that eligible connection's active tool catalog.
This is discovery metadata: the request still fails with 422, grants no access,
and creates no approval card. The agent must select the needed exact names and
submit a new request; normal user approval, catalog-version and policy checks
still apply. Ineligible connections and inactive catalog entries are excluded.
