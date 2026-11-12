# MCP Fixture Smoke Harness

Paperclip's MCP permission work uses deterministic fixture servers so policy
logic can be tested without real customer credentials or live integrations.

Run the local smoke:

```sh
pnpm smoke:mcp-fixtures
```

The runner starts one local stdio fixture and one remote-style HTTP fixture,
checks the local Paperclip `/api/health` endpoint when available, then exercises:

- allow and deny decisions
- approval-gated writes
- audit records
- fixture runtime startup, health, slow response, crash response, and teardown
- missing-secret and fake OAuth failure paths
- schema-change quarantine
- malicious metadata/result handling
- approved-write idempotency

Use a specific dev instance URL:

```sh
pnpm smoke:mcp-fixtures -- --paperclip-url http://127.0.0.1:3100
```

Require the dev instance health check:

```sh
pnpm smoke:mcp-fixtures -- --require-paperclip
```

JSON output for CI or release-smoke ingestion:

```sh
pnpm smoke:mcp-fixtures -- --json
```

## Fixture Catalog

The catalog lives in `scripts/mcp-fixtures/catalog.mjs` and includes:

- echo/calculator/time read tools
- synthetic todo and KV tools
- outbox email tools
- mock social/blog publishing tools
- malicious metadata and malicious result tools
- slow and crashing stdio tools
- fake OAuth and missing-secret tools

The catalog also defines the first profile set:

- `read-only`
- `approval-gated-writes`
- `security-hostile`
- `runtime-lifecycle`

The first-install demo definitions are:

- `paperclip-self-read`
- `child-issue-proposal`
- `github-triage`
- `update-sender`
- `content-publishing`
- `local-project-helper`
- `ops-status`
- `crm-sales-note-draft`

## Phase 5a User-Story Harness

The Phase 5a MCP production harness scripts the accepted user-story catalog
from PAP-12338 section 5:

```sh
pnpm test:e2e:mcp-user-stories
```

By default this runs only the currently runnable stories (US-1..US-5 and
US-8..US-10) against the Playwright-managed local instance. Each scenario seeds
a real company, a real Scout agent, and a deterministic MCP fixture connection;
then it drives the gateway/Test-tab APIs plus the UI pages that provide
evidence screenshots under `test-results/mcp-user-stories/`.

Run the full catalog, including dependency-gated placeholders for US-6 and
US-7, with:

```sh
pnpm test:e2e:mcp-user-stories -- --include-gated
```

The browser side uses the same `PAPERCLIP_PLAYWRIGHT_CHANNEL` override as the
rest of `tests/e2e`. In minimal containers, install the Playwright system
dependencies or point `PAPERCLIP_PLAYWRIGHT_CHANNEL` at the managed branch
service's known-good Chromium wrapper before running the browser smoke.
