# Cases and structured work records — agent access

Product map: [Cases and structured work records](../feature-map/cases.md).

Feature ID: `cases`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. Scoped working-tree and live evidence is recorded below; it does not
qualify every operation in the baseline tables. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `browse`

Capability ID: `cases/browse`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/cases` (search/status/type/project filters,
  `sortField=updated|created|title|status|type`, `sortDir=asc|desc`,
  `groupBy=none|status|type|project`, and offset after authorization). Sorting and
  group ordering apply to the full authorized result before pagination. Defaults
  retain newest-updated ordering; status uses lifecycle order and project groups
  use stable project IDs with unassigned cases last.
- `GET /api/companies/{companyId}/cases/types` (distinct types from accessible standalone cases).

Agent access: `available` — REST / native call_api; dedicated native `read_case`
for an authorized standalone case or the task's primary case; agent cases reference.

Native `read_case` has bounded UTF-8 JSON paging through the same authorized
case GET (`agentRead=true`). Small cases remain structured; large cases and
`section: "fields"` expose exact `readPage.text` chunks. Continuations require
`offsetBytes` and the returned `snapshot`; a changed case/task version or selected
projection returns 409. Every successful page retains handoff/task versions.
Generic `call_api` remains optional and is not needed to recover large fields.
`section: "document"` with `documentKey` reads a historical case-owned document;
adding `documentIssueId` selects a current primary or linked task document.
Bodies use the same bounded JSON pages without generic API tools. Each page
rechecks source-task access and linkage, excludes system/quarantined documents,
and binds the snapshot to the selected document identity, revision and body.


Policy: enableCases gate; company/case/task boundaries, active run where required,
source trust, and checked-out mutation ownership.

Evidence: `source-only` — [implementation](../../server/src/routes/cases.ts#L592) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: No dedicated production list_cases binding is required because the REST fallback
exists. Case pages are read-only; this does not remove agent mutation APIs.

## `structure`

Capability ID: `cases/structure`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/cases`.
- `PATCH /api/cases/{id}`.

Agent access: `available` — REST / native call_api; native `create_case` creates a
fresh case and its first task through required `kickoff` and
`workflow_document_text`; new-case handoff API calls require the same text.
It is saved verbatim as ordinary task document `workflow` before delivery,
with create-only revision semantics and task mutation authority when binding.
Tool prompts, API schema descriptions and the case guide recommend both a Mermaid
`stateDiagram-v2` map and prose defining transition triggers, evidence, next
agents, human waits and correction/escalation rules. Diagram labels are advisory.
`initialDocuments` writes ordinary task documents before dispatch.
`update_case` changes title, summary and whole-object fields. Reads/updates
default to the primary workflow case and retain REST authorization. Standard
`read_document` / `write_document` operate on the active task; rollup references
identify other accessible tasks and their authenticated REST read paths. Native
`read_case` document selection can open those references without `call_api`.

Policy: enableCases gate; company/case/task boundaries, active run where required,
source trust, and checked-out mutation ownership.

Evidence: `source-only` — [implementation](../../server/src/routes/cases.ts#L592) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Structured case data is supported; grouping/rendering is presentation, not a new
endpoint requirement.

Dedicated native CRUD is standard-mode/enableCases gated and has strict schemas;
fact updates cannot change status, routing or permissions. Update receipts are
run-scoped; creation always delegates to the principal-scoped
handoff receipt. Missing kickoff or workflow text is rejected before any writes.
Workflow text and other seeds share a bounded budget; extra seeds cannot replace
the workflow key. Later transfers use ordinary revision tools for edits. Documents use ordinary task revision checks. Historical
case-document REST/storage remains compatible, but separate native case-document
tools are retired. Deterministic production-boundary tests are in
[native case tools](../../server/src/services/native-runtime/native-case-tools.integration.test.ts)
and the [assembled native journey](../../server/src/__tests__/case-handoff-native.integration.test.ts);
the real-provider campaign `local-2026-10-19T19-57-00-135Z` also passed all 12
receipt workflow checks using the dedicated tools. This scoped evidence does not
qualify every generic case REST operation or subsequent tool replacements.
The newer create_case/initialDocuments/task-rollup implementation has its own
scoped deterministic verification in that record, including native creation and
authenticated HTTP replay/denial tests. The later campaign
`local-2026-10-19T21-39-45-440Z` passed all 13 live workflow checks using seeded
ordinary task documents and task-document reads/writes. Its returning builder
reused its own persisted session. Kickoff was initiated through the harness API;
provider-generated native `create_case` kickoff remains deterministically
verified rather than live-provider qualified. See the
[verification record](../../doc/plans/2026-10-19-persistent-case-handoffs.md).

The subsequent required workflow-document contract has authenticated HTTP,
real-database/API schema and assembled native-runner coverage. Receiving context
prioritizes its authorized reference, and fresh-session recovery keeps workflow
text reference-only as well. These controlled-provider tests verify required
creation, atomic task document persistence, replay and no automatic body injection;
the earlier live campaign predates this requirement and is not requalified.

## `history`

Capability ID: `cases/history`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/cases/{id}/events`.
- `GET /api/cases/{id}/documents/{key}/revisions`.
- `GET /api/issues/{id}/documents/{key}/revisions` for task-owned rollup documents.

Agent access: `available` — REST / native call_api.

Policy: enableCases gate; company/case/task boundaries, active run where required,
source trust, and checked-out mutation ownership.

Evidence: `source-only` — [implementation](../../server/src/routes/cases.ts#L592) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Source-backed access only; case visibility and document locks still apply.

## `task-links`

Capability ID: `cases/task-links`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/cases/{id}/links`.
- `GET /api/issues/{issueId}/cases`.

Agent access: `available` — REST / native call_api.

Policy: enableCases gate; company/case/task boundaries, active run where required,
source trust, and checked-out mutation ownership.

Evidence: `source-only` — [implementation](../../server/src/routes/cases.ts#L592) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Case/task association exists; source trust and issue visibility must be tested
with agent credentials.

## `handoffs`

Capability ID: `cases/handoffs`.

Review: `baseline`.

API: `present` — POST /api/companies/{companyId}/case-handoffs; GET /api/cases/{id}/handoffs; POST /api/cases/{id}/handoffs/{handoffId}/retry and /cancel.

Agent access: `available` — live native `handoff_case`, native API discovery/call_api, and authenticated agent REST. Initial kickoff creates or explicitly binds an ordinary task; subsequent calls reuse it.

Terminal destination: `to: "done"` records closure intent for an existing primary task, using case read/mutation and normal task mutation authority. It does not assign, wake, yield, or satisfy completion evidence. Normal accepted task completion atomically closes the case; a current execution's Stop, task cancellation, or reassignment invalidates the intent. Run-scoped Stop preserves newer work; cancelling terminal intent without a source run requires fenced current task ownership. Waiting on review or user input preserves it. Ordinary completion without a terminal intent leaves case status unchanged.

Retention: whole-company deletion removes case history before dependent tasks/agents. Individual agent purge returns `409 agent_case_history_retained` when handoffs reference the agent; termination preserves its attribution.

Policy: enableCases; standard mode; ordinary task creation/assignment authority; agents transfer only their own work; current case/task versions; company and retained task/project access intersection; existing review, Stop, budget, and workspace gates. Idempotency belongs to the authenticated principal, not a provider run. Cancellation remains available while the feature is disabled.

Delayed assignment rechecks the original caller's current assignment authority
using internal, server-derived provenance. The context is not returned by
history or recovery APIs. Missing historical provenance fails closed. After an
assignment is applied, delivery checks recipient admission rather than requiring
the former assignee to retain task access.

Cloud-user transfers confirm current stack membership through the uncached
tenant portfolio API before taking task locks. The short-lived proof is bound
to the original user and configured stack identity. Owner elevation also
requires the current managed feature setting. Missing membership, a viewer
role, an unavailable lookup, or a changed configuration holds the transfer.
No Cloud role or administrator grant is stored in the handoff context.

Evidence: `verified` — 2026-10-19 working-tree implementation. The [assembled native integration](../../server/src/__tests__/case-handoff-native.integration.test.ts) passed with actual runnerd and a controlled provider; [legacy HTTP integration](../../server/src/__tests__/case-handoff-legacy.integration.test.ts) and real-database authority/recovery tests passed. The later API-key campaign `local-2026-10-19T19-14-18-642Z` completed four real native runs and terminal case closure. The earlier subscription HTTP 429 remains recorded as a failed attempt; it was not regraded. See the [verification record](../../doc/plans/2026-10-19-persistent-case-handoffs.md).

Verification: `passed` — deterministic boundaries include native tool acceptance/yield, process settlement, same-task successor context, authenticated HTTP replay, denied private sources, version conflicts, review gates and restart/acknowledgment recovery. The configured-provider correction round trip passed using API credentials. The latest `local-2026-10-19T21-39-45-440Z` campaign passed 13 checks with task-owned documents, four nonoverlapping runs, same-task transfers, returning-builder session reuse and terminal case closure. The earlier `local-2026-10-19T21-32-43-612Z` campaign remains failed because the task revision API omitted stored writer-run attribution; the subsequent authorized projection fix was qualified by the new campaign. Compact context content/omission assertions retain separate deterministic evidence.

Gaps: Full provider qualification is recorded separately from source presence and deterministic service tests.
