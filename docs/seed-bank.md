# Hindsight Seed Bank

`pnpm paperclip-seed-bank` pre-seeds an existing per-agent hindsight bank with domain-specific pages from gbrain. The same core module also exposes `seedBankAfterAgentBankCreated` so the hindsight plugin can schedule a seed after it creates a per-agent bank.

## Invocation

Run from the Paperclip repo root:

```sh
pnpm paperclip-seed-bank \
  --agent-id 5b6342f5-d2b8-456d-adf6-fe27a08e3eea \
  --company-id aaced805-3491-4ee5-9b14-cdf70cb81d47 \
  --gbrain-sources default,gstack-code-trol,gstack-code-agma \
  --max-pages 40 \
  --dry-run
```

The default bank id is `paperclip::<companyId>::<agentId>`. Use `--bank-id` only when intentionally targeting a non-canonical existing bank.

Required runtime inputs:

- `PAPERCLIP_API_URL` and `PAPERCLIP_API_KEY`, or `--paperclip-api-url` / `--paperclip-api-key`, to read agent records.
- `GBRAIN_MCP_URL` or `--gbrain-url`, pointing at the gbrain MCP HTTP endpoint.
- `HINDSIGHT_MCP_URL` or `--hindsight-url`, pointing at the hindsight MCP HTTP endpoint.
- `PAPERCLIP_HOME` when you want the default ledger under a specific instance. Otherwise the ledger defaults to `~/.paperclip/instances/default/data/seed-bank-ledger.db`.

## gbrain MCP Auth

gbrain's admin MCP at `http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/mcp` requires an OAuth `client_credentials` bearer token. **`PAPERCLIP_API_KEY` is NOT accepted** as the gbrain bearer — it is rejected with `401 missing or malformed bearer token`. The token is minted from the per-agent client credentials mounted on every heartbeat pod at `/etc/paperclip-plugin-gbrain/clients.json` (only seeded for agents in the gbrain plugin's clients map — currently CTO, Staff Engineer, and a handful of others).

Operators run this snippet to mint a 24h bearer for the seed-bank invocation:

```sh
export PAPERCLIP_MCP_BEARER_TOKEN=$(node -e "
const fs=require('fs');
const me=JSON.parse(fs.readFileSync('/etc/paperclip-plugin-gbrain/clients.json','utf8'))[process.env.PAPERCLIP_AGENT_ID];
(async()=>{
  const r=await fetch('http://gbrain-mcp-admin.paperclip.svc.cluster.local:3130/token',{
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'client_credentials',client_id:me.client_id,client_secret:me.client_secret}),
  });
  process.stdout.write((await r.json()).access_token);
})();
")
pnpm paperclip-seed-bank …
```

Prefer the `PAPERCLIP_MCP_BEARER_TOKEN` environment variable over `--mcp-bearer-token` in live dogfood runs so package-manager command banners do not echo the bearer in logs.

Hindsight's MCP at `http://hindsight-api.hindsight.svc.cluster.local:8888/mcp` is unauthenticated in-cluster; the same bearer flag is sent there but the server ignores it. The public gbrain MCP (`paperclip.blockcast.net/gbrain/mcp`) is OAuth-protected too and also will not accept `PAPERCLIP_API_KEY`. Use the in-cluster admin URL for operator invocations.

## Query Derivation

v1 is deterministic and does not call an LLM. It builds queries in this order:

1. The agent `capabilities` prose, as one full query.
2. Each `adapterConfig.paperclipSkillSync.desiredSkills` last path segment, converted from slug form into words.
3. The reporting parent agent's `capabilities` prose, when available.

The tool calls gbrain query with salience and recency enabled, dedupes by `(source, slug)`, and keeps the first `--max-pages` candidates in query-result order.

## Hindsight Lifecycle Hook

When `paperclip-plugin-hindsight` creates a new per-agent bank, it should call `seedBankAfterAgentBankCreated` from `scripts/seed_bank_core.mjs` with the created agent record and the same bank id it just created:

```js
await seedBankAfterAgentBankCreated({
  agent,
  bankId,
  reportsTo,
  enqueueSeedBankJob: (job) => queue.enqueue("paperclip-seed-bank", job),
  recordSeedBankFailure: (failure) => state.set(retryKey(failure), failure),
});
```

The hook derives the same deterministic query plan as the manual CLI and schedules exactly one seed job for the canonical `paperclip::<companyId>::<agentId>` bank id unless the caller passes the just-created bank id explicitly. Queue failures are caught and returned as `{ ok: false, retryable: true }`; callers should surface the recorded failure in plugin health/state and offer a retry action. Even if failure recording itself fails, the hook returns the secondary `failureRecordError` instead of throwing. The hook must not throw queue failures back into agent creation, because hindsight bank seeding is a best-effort domain-prior bootstrap rather than a prerequisite for creating the agent or bank.

## Dry Run

`--dry-run` prints the derived queries, candidate pages, hashes, and action plan. It does not call hindsight ingest and does not write ledger rows. The text report includes `ledgerRows: before=<n> after=<n>` so operators can verify the ledger count did not change.

## Real Run And Idempotency

Before ingesting, the tool checks that the target hindsight bank already exists. It does not create banks; bank creation remains owned by the hindsight plugin.

For each candidate page, the tool fetches the full markdown body from gbrain and computes a SHA-256 hash. It verifies the target bank with hindsight `get_bank_stats`, ingests changed pages through `sync_retain` with `context=gbrain-seed-bank` and `document_id=<gbrain-slug>`, then writes a ledger row only after ingest succeeds. Re-running with the same page body skips unchanged rows.

`sync_retain` waits for each page to be queryable, so a first live seed can take tens of seconds per page. For manual dogfood, `--max-pages 20` is often a better heartbeat-sized target than 40 while still proving the 20-40 page acceptance range.

## Refresh Mode

Use `--mode refresh` for existing seeded banks:

```sh
pnpm paperclip-seed-bank \
  --agent-id 5b6342f5-d2b8-456d-adf6-fe27a08e3eea \
  --company-id aaced805-3491-4ee5-9b14-cdf70cb81d47 \
  --mode refresh \
  --max-pages 40
```

Refresh mode uses the same query and candidate logic, then re-ingests only pages whose current gbrain body hash differs from the SQLite ledger row.

## Ledger Schema

The SQLite ledger lives at `${PAPERCLIP_HOME}/data/seed-bank-ledger.db` by default.

```sql
CREATE TABLE IF NOT EXISTS seed_bank_pages (
  bank_id TEXT NOT NULL,
  gbrain_source TEXT NOT NULL,
  gbrain_slug TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  page_byte_count INTEGER NOT NULL,
  PRIMARY KEY (bank_id, gbrain_source, gbrain_slug)
);
```

The ledger is an optimization. Correctness still depends on hindsight replacing by title, so wiping the ledger can cause safe re-ingest but should not create duplicate documents.

## Failure Modes

- Missing bank: the tool fails before ingest and points at the hindsight plugin bank-creation prerequisite.
- Partial ingest: a ledger row is written only after the matching hindsight ingest succeeds.
- Wrong target: the report prints the bank id before listing candidates; verify it is a per-agent bank, not `agent-memories`.
- Non-deterministic query drift: v1 derives queries only from stored agent fields and desired skill slugs.
- Missing SQLite runtime: the ledger adapter requires `python3` with stdlib `sqlite3` support in the operator environment.
- Lifecycle hook queue failure: `seedBankAfterAgentBankCreated` returns a retryable failure payload and calls `recordSeedBankFailure` when provided; agent creation and bank creation should still complete.
