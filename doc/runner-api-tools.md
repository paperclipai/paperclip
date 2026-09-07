# Runner API escape hatch

`search_api` and `call_api` extend the native runner when an available dedicated
operation cannot express the requested work. Existing tools remain preferred;
agents do not have to search before using them. Only two tool definitions are
advertised. The API catalog is returned on demand, never injected into the
initial prompt.

## Controlled rollout

The escape hatch is disabled by default. Set
`PAPERCLIP_RUNNER_API_TOOLS_ENABLED=true` on the server to enable it. For an
initial company rollout, also set `PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS` to a
comma-separated list of company UUIDs. An unset list allows every company;
an explicitly empty list allows none. IDs must match exactly.

The server always requires the explicit `true` flag, including for server-owned
bindings. A binding can disable these tools for a baseline eval but cannot enable
them without operator opt-in. Setting the flag to `false` disables them. The server checks this switch when advertising tools,
when accepting a call, and immediately before HTTP dispatch after preparing any
files. Existing dedicated tools remain available. Operators must update the
environment of each server process and restart it for deployment-level changes;
this environment switch is not a live settings API.

Evaluate selected companies first. Compare success, unnecessary fallback calls,
cost, and latency against the dedicated-tool baseline before widening. Keep the
switch disabled if authorization, replay, or cost accounting fails.

## Discovery and requests

```json
{"query":"create project","limit":5}
```

Search is deterministic lexical ranking over OpenAPI paths, summaries and the
old skill reference. It supports task/issue and other terminology, exact
`METHOD /api/path/{parameter}` lookup, and opaque query/catalog-bound pagination.
Results include resolved request schemas, response descriptions, authorization
metadata, work modes, examples where available, and relevant dedicated tools
with their supported parameters. `limit` defaults to five and is capped at ten.

```json
{"operationId":"PATCH /api/projects/{id}","pathParams":{"id":"PROJECT_UUID"},"body":{"description":"Updated project description"}}
```

The catalog determines method and path. `companyId` is filled from the active
binding. Scalars and arrays are accepted in `query`. `body` defaults to JSON;
`contentType` supports text and raw uploads. `files` accepts entries containing
exactly one authorized `artifactId` or task-workspace `path`, and an optional
multipart `field`. No arbitrary URL, headers, authentication, or remote file URL
can be supplied. Routes still validate payloads and enforce permissions.

Requests have a 30-second HTTP timeout, 16 KiB URL limit and 10 MiB payload/response
transfer limit. Responses above 24 KiB and binary responses become company-owned
assets with retrievable references; text previews are limited to 2,000 bytes.
All redirects are refused. Oversized or interrupted mutation responses have an
unknown outcome, requiring inspection before another mutation.
Mutation responses with HTTP 5xx, HTTP 408, redirects, or malformed JSON also
retain an unknown outcome. A server may have committed the write before it
failed to return a valid response.

## Authority and replay

The server revalidates the active native run, assigned task and actor, then
creates a server-held agent JWT bound to that company and run. Requests go
through the actual HTTP router with its authorization, validation and domain
audit behavior. An additional `runner.api_called` receipt attributes mutations
to the run even where older route audit events omit that field.
The run and work mode are checked again after asynchronous file preparation, so
a stopped run cannot dispatch an upload prepared under its earlier binding.

Ask and pre-acceptance Plan permit reads through the escape hatch. Existing
dedicated-tool exceptions are unchanged. Runner-owned checkout, completion,
status/assignment transitions, approval decisions and execution-control actions
cannot be bypassed through generic calls. Routine creation, schedule/trigger
changes and manual/public routine execution require the existing scheduling
clients. Direct workspace runtime commands, runtime-slot stop/restart, case
automation retries and skill test-run controls also require their existing
execution clients. Gateway session credentials cannot enter generic results.
Routine metadata remains readable; annotation threads, comments and thread
resolution remain available through the fallback. API-only ordinary fields, such as a
task's `billingCode`, remain accessible even when a dedicated tool covers other
fields on that endpoint.

Mutation call IDs reserve a durable receipt in the run's existing `resultJson`
before dispatch. Replays return the recorded result. Reusing an ID with different
arguments is rejected. A crash after reservation leaves an unknown outcome and
never automatically resends the mutation. The limit is 512 mutation receipts per
run. No database migration is needed.

Workspace uploads use the existing workspace resource containment checks,
no-symlink file opens covering every path component, and bounded descriptor reads.
Local uploads require Linux or macOS; authorized artifacts work on other hosts.
Lifecycle-sensitive endpoints require an inline JSON object, so a raw uploaded
JSON file cannot hide protected fields from policy checks. Artifacts must belong
to the bound company. Secret-value access, credential management, secret proposals
and company exports require their existing secure clients. Search describes these
operations as restricted. `call_api` rejects them before creating a replay receipt
or making an HTTP request. Safe secret metadata listing remains available.
Agent credentials are never returned to the model. Streaming, WebSocket, MCP and authentication
handshakes are documented as protocol operations requiring their existing clients.

## Catalog maintenance

`runner-api-catalog.ts` builds from the server OpenAPI registry. Experimental
pipeline, Cases and smoke-lab routes now share their validators with discovery.
Seven Cases/pipeline route shapes are multiplexed by resource identity: the Cases
router intentionally forwards unknown resources to the pipeline router. Their
separate catalog entries explain which resource identifier is required. Registry
authorization descriptions are documentation; actual route checks are authoritative.

Regenerate old-skill enrichment after editing its API reference:

```sh
node scripts/generate-runner-api-reference.mjs
node scripts/generate-runner-api-reference.mjs --check
node scripts/generate-runner-experimental-api-metadata.mjs
node scripts/generate-runner-experimental-api-metadata.mjs --check
```

Mounted-route coverage tests include experimental routes. Three WebSocket mounts
are explicitly classified in the catalog. Shared protocol-action catalogs,
provider projections and generated compatibility checks include both tools.

## Verification and paid evals

The companion `paperclip-evals` worktree contains `evals/runner-api-tools`.
Its README documents explicit case/model selectors, the cumulative budget ledger,
fixture reset, progressive batches, and Evalbook generation. No command defaults
to running the entire paid suite. Capability, forced operation contracts and
paired common-operation regressions are reported separately.

Provider-free integration tests exercise real runnerd → PRP → authority → HTTP,
route validation and audit, stale bindings, Ask/Plan restrictions, identity
spoofing, file containment, uncertain mutation receipts and fixture isolation.

The Evalbook viewer uses the existing shared viewer and stylesheet on master.
The report retains actual persisted-state summaries for private local inspection;
public replay continues to withhold company-state details.

The ACPX sidecar includes the upstream terminal-usage accounting correction from
`origin/codex/evalbook-default-chat-sept6`. Its qualified Claude executable requires
Linux x64. The first macOS stage records a zero-cost ACPX admission failure. A later user-authorized
OpenCode/OpenRouter Sonnet profile reached a real HTTP read, but the attempt failed
on a missing harness completion contract and incomplete terminal accounting. The
harness contract is corrected. The missing fourth request was subsequently
recovered from the matching OpenRouter session and generation billing record;
the original failed attempt remains immutable. New attempts retain an append-only,
flushed event journal and bounded provider trace outside disposable runtime files.
Provider-free startup succeeds for OpenRouter Sonnet and DeepSeek. See
`doc/plans/2026-09-07-runner-api-production-readiness.md` for remaining release gates.
