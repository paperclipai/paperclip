# Runner API escape hatch

`search_api` and `call_api` extend the native runner when an available dedicated
operation cannot express the requested work. Use `set_task_monitor` to schedule or clear a one-shot task check; after confirming
the receipt, finish with `yielded` and `continuation.kind: "monitor"` to await that
task’s timer. `call_api` still rejects monitor/execution-policy lifecycle writes.
Existing tools remain preferred;
agents do not have to search before using them. Only two tool definitions are
advertised. The API catalog is returned on demand, never injected into the
initial prompt.

## Default availability and operator controls

The escape hatch is enabled by default. No environment variable is required.
The native `hire_agent` tool shares this availability policy.
Set `PAPERCLIP_RUNNER_API_TOOLS_ENABLED=false` on the server to disable these
tools. An explicit `true` also enables them; other explicit values fail closed.

Operators can restrict availability with `PAPERCLIP_RUNNER_API_TOOLS_COMPANY_IDS`,
a comma-separated list of company UUIDs. An unset list allows every company;
an explicitly empty list allows none. IDs must match exactly. This restriction
also applies when the enabled flag is unset.

A server-owned binding can disable these tools for a baseline eval but cannot
override an operator restriction. The server checks the policy when advertising
tools, when accepting a call, and immediately before HTTP dispatch after
preparing any files. Existing dedicated tools remain available. Operators must
update the environment of each server process and restart it for deployment-level
changes; this environment switch is not a live settings API.

All company, run, work-mode, credential, and lifecycle checks below still apply.

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

Requests have a 16 KiB URL limit and 10 MiB request/upload limit. **New response
captures are limited to 1 GiB of decoded bytes.** This is separate from the 24 KiB
inline/page limit. The receiver rejects an oversized Content-Length before
reading and counts actual bytes before writing, including chunked or compressed
responses. Oversized responses return `api_response_too_large`; narrow the query
or use the endpoint's own pagination. A mutation may already have committed, so
inspect its state rather than retrying it to obtain a smaller response.

Connection setup and stalled response reads time out after 30 seconds. An active
capture has a 10-minute total download deadline. Responses above 24 KiB stream
into a private temporary file, then into a company-owned asset. Memory stays
bounded by the inline prefix and stream buffers. Binary responses also become
assets; text previews are limited to 2,000 bytes.

Large captures reserve 1 GiB against a **durable 4 GiB per-run capture budget**
before creating a file. A completed capture settles to its actual byte count;
failed/interrupted captures retain the full reservation to bound retry loops.
A process restart does not reset that budget. Small inline responses and reads
of existing assets need no reservation. Concurrent large captures are limited
to **two per company and four per server process**, including the storage upload
and temporary-file cleanup. Budget exhaustion returns `api_response_capture_limit`;
concurrency exhaustion returns `api_response_capture_busy` without queuing more
large transfers. A **20 GiB company-wide quota** counts all stored `runner-api` snapshots plus
unattached reservations. Admission uses a company database lock, so runs and
server processes share the same quota. Existing snapshots from before this
change count too. Attaching an asset converts its reservation to actual stored
bytes; deleting the asset frees that capacity. Small binary snapshots also need
storage admission. Ordinary inline text/JSON and existing-asset pages do not.

Operators can set `PAPERCLIP_RUNNER_API_COMPANY_CAPTURE_MAX_BYTES` to a positive
safe integer of at least 1 GiB. Invalid values fall back to 20 GiB. No zero or
unlimited setting is accepted. This quota covers API snapshots, not all company
attachments. Storage capacity and backend limits still apply.

Handled pre-storage failures release the company reservation after temporary
file cleanup, but retain the run's charge against retry loops. After a metadata
transaction fails, a locking read must prove the asset was not committed before
the uploaded object is removed. Confirmed cleanup refunds the company quota. A crash, failed
cleanup, or ambiguous storage write keeps an unattached reservation. Operators
must reconcile possible orphan files/objects before deleting that reservation
from `runner_api_response_reservations`; no automatic expiry silently refunds
possibly occupied space. Linked rows are removed with their asset. Deleting a
run does not release its unattached company reservations.

Temporary files are removed on success or failure. Long captures revalidate the
active run at least every MiB or at the next chunk after one second, and again
before returning the snapshot. Stopping the run stops its download.

To inspect saved text without creating another artifact, call its authorized
content operation with `responseText`:

```json
{"operationId":"GET /api/assets/{assetId}/content","pathParams":{"assetId":"RETURNED_ARTIFACT_ID"},"responseText":{"offsetBytes":0,"limitBytes":8192}}
```

The result contains `data` as text (including JSON), plus `responseText` with
`offsetBytes`, `nextOffsetBytes`, and `totalBytes`. Continue at `nextOffsetBytes`
until it is null. Windows end at UTF-8 boundaries. The limit defaults to 24 KiB
and accepts 4–24,576 bytes. The server rejects binary content, invalid UTF-8,
and offsets inside a code point or beyond the response. This option only works
with GET; never repeat a mutation to retrieve another part of its response.
Read the saved artifact for a stable snapshot instead of paging a changing live
response. A text-window call against a live response above 24 KiB also returns
that snapshot's artifact reference; continue on its content operation. A saved
asset page never creates another asset. An unpaged asset read also fetches only
a bounded preview and returns the existing reference instead of copying the file. Offsets and total sizes use safe integer
byte counts, including values above 2 GiB. Existing assets larger than the 1 GiB
capture limit remain readable because each request transfers only a bounded range.
Request/upload limits and all route
authorization remain.
Saved asset pages use authenticated HTTP byte ranges. The storage provider reads
only the requested window, with at most two extra bytes for UTF-8/EOF handling.
The client validates `Content-Range`, the total size, and the received byte count;
it rejects unsupported or inconsistent ranges instead of downloading the whole
asset for every page. Other GET routes are fetched once in full to create the
snapshot, so use the returned asset for subsequent pages. S3 uses streamed
multipart uploads for large snapshots. Asset sizes are stored as PostgreSQL
`bigint`, preserving the existing numeric API shape.

### Media files and upload limits

The 1 GiB limit covers new snapshots returned by `call_api`, such as large JSON
exports or binary API downloads. It does not raise attachment upload limits or
limit files an agent creates and edits inside its workspace. Saved asset downloads
stream from storage and support byte ranges, including video seeking.

`PAPERCLIP_ATTACHMENT_MAX_BYTES` separately defaults to 10 MiB for uploads and
native file handoffs. `call_api` uploads also have their own 10 MiB limit. Several
upload and handoff paths buffer complete files in memory; raising those defaults
to GiB sizes requires streaming ingestion and corresponding admission/budget
controls first. For a future video attachment workflow, 2 GiB per streamed file
is a reasonable default, with an operator override and storage quotas. Do not
claim that this response-paging change enables GiB attachment uploads.

Tool responses identify the HTTP route with `apiOperationId`. The native protocol
reserves `operationId` and `callId` for semantic tool-call identity; API metadata
must not masquerade as that envelope. Saved mutation receipts are normalized at
the tool boundary as well, without repeating their HTTP request.
All redirects are refused. Interrupted mutation responses have an
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
