# Paperclip External Task Protocol Specification

Status: Draft v1 (provider-agnostic)

Purpose: Define the protocol by which Paperclip interoperates with external task managers (Linear,
Jira, Asana, Notion, Trello, GitHub Issues, and others) so that external tasks can drive Paperclip
agent work and Paperclip work is visible in the external tool, without requiring an external user
account for every Paperclip agent.

## Normative Language

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `MAY`, and
`OPTIONAL` in this document are to be interpreted as described in RFC 2119.

`Implementation-defined` means the behavior is part of the implementation contract, but this
specification does not prescribe one universal policy. Implementations MUST document the selected
behavior.

Terminology in this document:

- `Provider` — an external task manager product (Linear, Jira, Asana, Notion, Trello, GitHub
  Issues, ...).
- `Connector` — an implementation of this protocol for one provider, hosted in the Paperclip
  plugin runtime.
- `External task` — a task record that lives in the provider.
- `Paperclip issue` — the native Paperclip task record.
- `Host` — the Paperclip control plane: companies, agents, issues, checkout, heartbeat runs,
  execution workspaces, budgets, approvals, blockers, issue documents, and work products.

## 1. Problem Statement

Teams already run their work in external task managers. Paperclip runs companies of agents. Today
these worlds only meet through manual copy/paste: a human reads a Linear issue, rewrites it as a
Paperclip issue, and later rewrites the outcome back into Linear.

This protocol defines the contract that lets an external task manager act as a **task source and
collaboration surface** for a Paperclip company, while Paperclip remains the **execution and
governance control plane**.

The protocol solves four interoperability problems:

- It defines one normalized task model so each connector translates provider payloads once, at the
  edge, instead of leaking provider-specific shapes into agent prompts and core logic.
- It defines how an external task becomes (or links to) exactly one Paperclip issue, with
  idempotent sync state that survives retries, webhook replays, and restarts.
- It defines how external assignment routes to Paperclip agents without creating a provider user
  per agent.
- It defines which writes flow back to the provider, under what policy, and with what provenance,
  so sync is predictable rather than chatty or destructive.

Important boundary (inherited from OpenAI Symphony, see Section 3.3):

- The connector is a tracker reader, sync engine, and routing layer.
- Provider writes (state transitions, comments, links) are explicit, policy-bound connector
  operations — never hidden side effects of core host logic.
- A successful agent run can end at a workflow-defined handoff state (for example review), not
  necessarily the provider's `Done`.

## 2. Goals and Non-Goals

### 2.1 Goals

- Let an external task manager act as a task source: active external tasks create or wake
  Paperclip issues under configured policy.
- Keep one normalized external-task model across all providers, with provider-specific data
  carried in an envelope, not in the core model.
- Route external assignment intent to Paperclip agents through deterministic, configurable rules.
- Reuse Paperclip's existing execution semantics — checkout as claim, heartbeat runs, execution
  workspaces, retries and recovery — as a Symphony-compatible orchestration profile.
- Make outbound writes explicit, policy-bound, idempotent, and attributable.
- Detect conflicts instead of silently overwriting either side.
- Give operators observability: link state, sync health, cursors, queues, retries, and conflicts.
- Keep connectors implementable as plugins, without private host internals.

### 2.2 Non-Goals

- Replacing the Paperclip board with a clone of any provider's UI.
- Real-time field-level collaborative editing between Paperclip and a provider.
- A generic workflow engine or a universal schema covering every provider feature. Provider
  features beyond the normalized model stay in the provider envelope.
- Creating a provider user account per Paperclip agent (supported as an OPTIONAL mapping, never
  required).
- Letting external systems bypass Paperclip governance: checkout, budgets, approvals, blockers,
  execution policies, and company boundaries remain host-owned.
- Migrating data: this is a sync protocol, not an importer/exporter for full historical fidelity.

## 3. System Overview

### 3.1 Main Components

1. `Task Source Adapter`
   - Provider client owned by the connector.
   - Fetches candidate external tasks and task states.
   - Normalizes provider payloads into the `ExternalTask` model.
   - Performs provider writes when policy allows.

2. `Task Link Store`
   - Persists the 1:1 association between an external task and a Paperclip issue.
   - Owns sync state: snapshots, fingerprints, cursors, status.
   - MUST be stored in plugin state/entities first; MAY be promoted to core schema once at least
     two connectors prove the model (see Section 17.3).

3. `Inbound Sync Engine`
   - Consumes webhooks and poll results.
   - Creates/updates Paperclip issues and imports comments with provenance.
   - Runs scheduled reconciliation to repair drift.

4. `Routing Engine`
   - Resolves external assignment intent into a Paperclip assignee using the ordered rule
     pipeline in Section 8.

5. `Execution Bridge`
   - Maps tracker-driven work onto host execution: issue checkout (claim), heartbeat runs,
     execution workspaces, retry/recovery. Defined as the Symphony profile in Section 9.

6. `Outbound Write Engine`
   - Applies the write policy in Section 10: progress comments, status projection, backlinks,
     artifact/PR links.

7. `Conflict Queue`
   - Records detected conflicts and exposes resolution actions (Section 11).

8. `Health Surface`
   - Operator-visible connector status: last webhook, last poll, last reconcile, cursor positions,
     queue depth, retry counts, current errors (Section 12).

### 3.2 Protocol Layers

The protocol is layered. A connector MAY implement lower layers without higher ones.

1. `Layer 1 — Task Source Adapter` (REQUIRED)
   - Normalized read access to provider tasks. Sufficient for browse/import UX.

2. `Layer 2 — Task Link` (REQUIRED)
   - Durable external-task ↔ Paperclip-issue association with sync state.

3. `Layer 3 — Execution Orchestration, Symphony Profile` (RECOMMENDED)
   - Active external states drive Paperclip issue creation/wake; Paperclip checkout/run/retry
     semantics are projected back as claim state.

4. `Layer 4 — Write and Sync Policy` (RECOMMENDED)
   - Policy-bound outbound writes and two-way comment/status sync.

A connector that implements Layers 1–3 for read-driven execution is a **Symphony-compatible task
source** (Section 9.6).

### 3.3 Relationship to OpenAI Symphony

OpenAI Symphony specifies a service in which an issue tracker drives isolated, autonomous coding
agent runs: normalized tracker issues, active/terminal state mapping, claim/run/retry/release
lifecycle, per-issue workspaces, repository-owned workflow policy (`WORKFLOW.md`), and
operator-visible observability.

This protocol deliberately defers to Symphony's semantics wherever Symphony solves the same
problem, and maps them onto existing host primitives:

| Symphony concept | This protocol |
| --- | --- |
| Tracker client + normalized issue | Task Source Adapter + `ExternalTask` (Section 5) |
| Active / terminal states | Connector state mapping (Section 7.2) |
| Claim | Paperclip issue checkout + execution lock (Section 9.2) |
| Running map / live session | Heartbeat runs + issue liveness state (Section 9.3) |
| Retry queued | Host retry/recovery + scheduled wakes (Section 9.3) |
| Released | Issue terminal/review/blocked, or external task no longer active (Section 9.3) |
| Per-issue workspace | Execution workspace / worktree (Section 9.4) |
| `WORKFLOW.md` | Workflow policy document (Section 9.5) |
| Tracker writes via agent tools, not orchestrator | Outbound Write Engine + connector tools (Section 10.1) |
| Status surface | Issue/run/connector health UI (Section 12) |

Where Symphony is intentionally narrow — single repository, coding agents only, one tracker, no
multi-tenant control plane — this protocol extends it with company scoping, multi-agent routing,
governance gates, issue documents/work products, and two-way sync policy. Section 9.6 defines what
a connector MUST do to claim Symphony-profile conformance. Appendix B gives a section-by-section
crosswalk.

### 3.4 Core vs Connector Boundary

The host MUST own:

- Company scoping and authorization of every mutation.
- Issue checkout, execution locks, heartbeat invocation, and execution workspace lifecycle.
- Budget, approval, blocker, and execution-policy enforcement.
- Issue documents and work products.
- The normalized protocol types, once validated (shared SDK package).

Connectors MUST own:

- Provider authentication and webhook verification.
- Provider polling, pagination, and cursor management.
- Provider-specific state mapping and the provider envelope.
- All provider writes (comments, transitions, fields, links).
- Provider-specific setup, settings, and issue-detail UI.

A connector MUST perform all Paperclip issue/comment/status mutations through host issue services
with plugin attribution. A connector MUST NOT write host tables directly.

## 4. Core Domain Model

Field names use camelCase, matching Paperclip API conventions. (Symphony uses snake_case; the
crosswalk in Appendix B maps equivalent fields.)

### 4.1 Entities

#### 4.1.1 ExternalTask

Normalized external task record produced by the Task Source Adapter. This is the only shape the
host, routing engine, and prompt/task-packet rendering may depend on.

Fields:

- `providerKey` (string)
  - Stable provider identifier: `linear`, `jira`, `asana`, `notion`, `trello`, `github_issues`.
- `externalId` (string)
  - Stable provider-internal ID. Used for lookups and link keys.
- `externalKey` (string or null)
  - Human-readable key where the provider has one (example: `ABC-123`). Null for providers
    without keys (Trello, Notion).
- `title` (string)
- `description` (string or null)
  - Normalized to Markdown on a best-effort basis; lossy conversions MUST be noted in the
    envelope.
- `state` (object)
  - `name` (string) — provider state/lane name.
  - `category` (enum) — normalized category: `backlog`, `active`, `review`, `blocked`, `terminal`
    (Section 7.2).
- `priority` (integer or null)
  - Normalized 0–4, lower is more urgent. Non-mappable provider scales become null with the raw
    value preserved in the envelope.
- `assignees` (list of external actor refs)
- `labels` (list of strings)
  - Trimmed, lowercased.
- `blockedBy` (list of external task refs: `{externalId, externalKey, state}`)
  - Derived from provider relations where supported; empty otherwise.
- `url` (string or null)
- `branchName` (string or null)
  - Provider-supplied branch metadata if available.
- `dueAt`, `createdAt`, `updatedAt` (timestamps or null)
- `revision` (string or null)
  - Provider revision/version/etag when available; used for conflict detection.
- `envelope` (object)
  - Provider-specific payload (Section 4.1.2). Opaque to the host.

#### 4.1.2 ProviderEnvelope

Provider-specific data that does not generalize. Carried alongside the normalized model, persisted
with the task link, surfaced in provider-specific UI, and available to connector tools. The host
core MUST NOT branch on envelope contents.

Representative envelope content per provider is listed in Appendix A.

#### 4.1.3 TaskLink

The durable 1:1 association between one external task and one Paperclip issue.

Fields:

- `id` (string)
- `providerKey` (string)
- `connectorInstanceId` (string)
  - One installed connector configuration (a provider MAY be installed multiple times per
    company, e.g. two Jira sites).
- `companyId`, `projectId`, `goalId`, `issueId` (strings; `issueId` is the linked Paperclip issue)
- `externalWorkspaceId`, `externalProjectId` (strings or null)
  - Provider container coordinates (team/project/board/database).
- `externalTaskId`, `externalKey`, `externalUrl`
- `originSide` (enum: `paperclip`, `external`, `manual_link`)
  - Which side created the pairing.
- `syncMode` (enum, Section 4.2.1)
- `runMode` (enum, Section 4.2.2)
- `fieldPolicy` (map field → owner, Section 4.1.4)
- `baseSnapshot` (object)
  - Last agreed projected state of both sides; the three-way merge base for conflict detection.
- `lastExternalRevision` (string or null)
- `lastPaperclipFingerprint` (string or null)
  - Hash of the last Paperclip-side state this connector projected outbound.
- `lastInboundAt`, `lastOutboundAt`, `lastReconcileAt` (timestamps or null)
- `status` (enum, Section 4.2.3)
- `statusDetail` (string or null)
  - Human-readable explanation for `conflict`, `error`, `paused`.

Invariants:

- A `(connectorInstanceId, externalTaskId)` pair MUST map to at most one active link.
- An `issueId` MUST appear in at most one active link per connector instance, and SHOULD appear in
  at most one active link overall; cross-connector double-linking is implementation-defined and
  MUST be surfaced in UI when allowed.
- Every link MUST belong to exactly one `companyId`, resolved at link creation, before any
  mutation on either side.

#### 4.1.4 FieldOwnershipPolicy

Per-field ownership controlling sync direction and conflict classification.

- Owners: `external`, `paperclip`, `shared`.
- Coverable fields (minimum): `title`, `description`, `state`, `priority`, `labels`, `assignee`,
  `dueAt`.
- Default policy (RECOMMENDED): `title`/`description`/`priority`/`labels`/`dueAt` owned by
  `external` for links with `originSide=external` (and by `paperclip` when
  `originSide=paperclip`); `state` is `shared` and mediated by Section 7.4 and Section 10.3;
  `assignee` is never directly synced — it flows through routing (Section 8).
- Writes from the non-owning side to an owned field MUST NOT be applied silently; they produce a
  conflict entry (Section 11) or are dropped per policy, and the choice MUST be visible in link
  health.

#### 4.1.5 RoutingRule

One rule in the connector's ordered routing pipeline (Section 8).

Fields:

- `order` (integer)
- `kind` (enum: `default_route`, `custom_field`, `label`, `state_lane`, `comment_command`,
  `user_mapping`)
- `match` (object, kind-specific: field id + value pattern, label pattern, lane/state name,
  external user id)
- `target` (object)
  - `agentId` (string) or `routingAlias` (string, e.g. `triage`, `qa`, resolved against company
    configuration).
- `enabled` (boolean)

#### 4.1.6 ExternalActor

Provenance identity for inbound content.

Fields:

- `providerKey`
- `externalUserId` (string)
- `displayName` (string)
- `mappedUserId` (string or null) — Paperclip user, if mapped.
- `mappedAgentId` (string or null) — Paperclip agent, if explicitly mapped (OPTIONAL feature).
- `isConnectorServiceAccount` (boolean)
  - True when the actor is the connector's own provider identity. REQUIRED for echo suppression
    (Section 10.4).

#### 4.1.7 SyncCursor

Per-connector-instance incremental sync state.

Fields:

- `scope` (string) — e.g. `tasks:<externalProjectId>`, `comments:<externalTaskId>`.
- `cursor` (string) — provider-opaque pagination/delta token or high-water-mark timestamp.
- `updatedAt` (timestamp)

Cursors MUST be persisted transactionally with the effects of the page they describe, so a crash
between "apply page" and "save cursor" re-applies idempotently rather than skipping.

#### 4.1.8 ConnectorHealth

Operator-visible runtime state per connector instance.

Fields:

- `lastWebhookAt`, `lastPollAt`, `lastReconcileAt` (timestamps or null)
- `webhookVerified` (boolean)
- `queueDepth` (integer) — pending inbound events.
- `retryCount` (integer) — currently scheduled retries.
- `conflictCount` (integer) — open conflict entries.
- `lastError` (object or null: `{category, message, at}`)
- `status` (enum: `healthy`, `degraded`, `error`, `paused`)

### 4.2 Enumerations

#### 4.2.1 `syncMode`

Per-link data flow direction:

- `import_only` — external → Paperclip only.
- `export_only` — Paperclip → external only.
- `bidirectional` — both directions under `fieldPolicy`.
- `observer` — read and display external state; mutate neither side.
- `disabled` — link retained, no sync.

#### 4.2.2 `runMode`

Per-link execution posture:

- `paperclip_controlled` — Paperclip governance decides when agents run; external state changes
  inform but do not command execution.
- `symphony_compatible` — active external states create/wake Paperclip work automatically per
  Section 9; the external tracker effectively drives dispatch.
- `external_observer` — no execution coupling; link exists for visibility only.

#### 4.2.3 Link `status`

- `pending` — link created, first sync not yet completed.
- `healthy` — last sync succeeded, no open conflicts.
- `conflict` — one or more unresolved conflict entries.
- `error` — last sync attempt failed; retry scheduled or exhausted.
- `paused` — operator suspended sync.
- `unlinked` — association severed; record retained for audit.

### 4.3 Stable Identifiers and Normalization Rules

- `External Task ID` — use for provider lookups and link keys. Never display-only keys.
- `External Key` — use for human-readable logs, comments, and UI.
- `Link key` — `(connectorInstanceId, externalTaskId)`.
- `Idempotency key` for inbound effects — `(connectorInstanceId, externalTaskId, eventId)` where
  the provider supplies event IDs, else a content hash of the normalized change. Replayed webhooks
  MUST NOT duplicate issues or comments.
- `Idempotency key` for outbound effects — `(linkId, effectKind, paperclipSourceId)` (e.g. the
  Paperclip comment ID being mirrored). Retried jobs MUST NOT double-post.
- State names compare after trim + lowercase.
- Labels normalize to trimmed, lowercased strings.
- Timestamps normalize to ISO-8601 UTC.

## 5. Task Source Adapter Contract

### 5.1 REQUIRED Operations

A connector MUST implement:

1. `listCandidateTasks(scope, cursor) -> {tasks: ExternalTask[], cursor}`
   - Return tasks in configured containers (team/project/board/database), filtered to configured
     states where the provider supports server-side filtering, paginated.

2. `getTask(externalTaskId) -> ExternalTask`

3. `getTaskStates(externalTaskIds) -> {externalTaskId -> state}`
   - Batched state refresh for reconciliation (Section 7.1.3) and run-eligibility checks
     (Section 9.3).

4. `listComments(externalTaskId, cursor) -> {comments: ExternalComment[], cursor}`
   - Each comment carries `externalCommentId`, `ExternalActor`, body (Markdown best-effort),
     timestamps.

5. `verifyWebhook(request) -> VerifiedEvent | reject`
   - Validate provider signatures/secrets where the provider supports them (Section 14.2). For
     providers without signed webhooks, the connector MUST treat webhook payloads as untrusted
     hints and confirm by API read-back before applying effects.

### 5.2 OPTIONAL Write Operations and Capability Declaration

Write operations are OPTIONAL per connector and gated by policy (Section 10):

- `createTask(projection) -> ExternalTask`
- `updateTaskState(externalTaskId, targetStateName)`
- `postComment(externalTaskId, body, attribution) -> externalCommentId`
- `setFields(externalTaskId, partial fields per fieldPolicy)`
- `setBacklink(externalTaskId, paperclipUrl)`
  - Via link field, custom field, or pinned comment — provider-dependent.

A connector MUST declare a static capability set (readable by host UI) enumerating which
operations it implements, which state categories it can map, whether webhooks are signed, and
which routing rule kinds it supports. Host UX MUST degrade gracefully (hide actions, explain
gaps) based on declared capabilities.

### 5.3 Normalization Requirements

- Adapter output MUST match Section 4.1.1. Provider payload fields with no normalized home go in
  the envelope.
- State category mapping (Section 7.2) is part of adapter configuration, not code, wherever the
  provider has user-defined workflows (Jira, Linear, Trello lists, Notion selects).
- Rich text MUST convert to Markdown best-effort; the envelope SHOULD retain the source format
  reference for lossless round-trips where the connector supports them.
- Person references in body text SHOULD be converted to plain display names; raw provider mention
  syntax MUST NOT leak into Paperclip issue bodies where it could be misparsed as Paperclip
  mentions.

### 5.4 Error Handling Contract

RECOMMENDED error categories:

- `provider_auth` (expired/invalid credentials)
- `provider_rate_limited` (with retry-after when available)
- `provider_request` (transport failures)
- `provider_status` (non-2xx)
- `provider_payload` (unparseable/unknown payload)
- `cursor_invalid` (provider rejected or lost the cursor)
- `webhook_signature` (verification failure)

Engine behavior on adapter errors:

- Candidate fetch failure: log, mark health `degraded`, skip this tick; never tear down existing
  links or active work.
- State refresh failure during reconciliation: keep current link state; do not release claims or
  stop runs on missing data (matches Symphony's reconciliation posture).
- `cursor_invalid`: fall back to a bounded full re-list with idempotent re-apply; never wipe and
  re-import.
- `provider_rate_limited`: back off honoring provider guidance; webhook intake continues to queue.

## 6. Task Link Lifecycle

### 6.1 Link State Machine

```
                +-----------+
   create ----> |  pending  |
                +-----+-----+
                      | first sync ok
                      v
                +-----------+   conflict detected    +-----------+
        +-----> |  healthy  | ---------------------> | conflict  |
        |       +-----+-----+                        +-----+-----+
        |             | sync failure                       | resolved
        |             v                                    |
        |       +-----------+ <--------------------------- +
        |       |   error   |
        |       +-----+-----+
        |             | retry ok
        +-------------+

   operator pause from any state -> paused (resume returns to previous state)
   unlink from any state        -> unlinked (terminal; record retained)
```

Transitions MUST be recorded with timestamps and causes in the link record or its audit trail.

### 6.2 Link Creation Paths

1. `Import` (`originSide=external`)
   - An external task is selected (manually, or automatically under `runMode=symphony_compatible`
     state mapping) and a Paperclip issue is created from its projection.
   - The created issue MUST carry: source attribution (provider, external key, URL), the
     normalized description, and routing-resolved assignee (Section 8).

2. `Export` (`originSide=paperclip`)
   - A Paperclip issue is projected into the provider via `createTask`.
   - REQUIRED only for connectors declaring write capability.

3. `Manual link` (`originSide=manual_link`)
   - Operator pairs an existing external task with an existing Paperclip issue.
   - The connector MUST compute an initial `baseSnapshot` from both sides and surface immediate
     divergence as conflicts rather than picking a winner.

### 6.3 Deduplication

Before creating an issue or external task, the connector MUST check, in order:

1. Active link with the same `(connectorInstanceId, externalTaskId)`.
2. Paperclip backlink already present on the external task (custom field/comment marker).
3. External URL/key reference already present on a Paperclip issue in the same company.

Title-similarity matching MAY be used to *warn* in import UX; it MUST NOT silently merge.

### 6.4 Unlink and External Deletion Semantics

- Unlink severs sync but MUST NOT delete either side's record.
- When an external task is deleted/archived: the connector MUST NOT delete or cancel the Paperclip
  issue. Default behavior: mark the link `conflict` (`statusDetail: external task deleted`),
  comment on the Paperclip issue, and let the assignee/operator decide. `import_only` links with
  no Paperclip-side activity MAY auto-unlink.
- When a Paperclip issue is cancelled/deleted: outbound policy decides whether to comment and/or
  transition the external task; the connector MUST NOT delete the external task unless an
  operator explicitly invokes a delete capability.

## 7. Inbound Synchronization (External → Paperclip)

### 7.1 Event Channels

A connector MUST implement at least one push or pull channel, and MUST implement reconciliation.

1. `Webhooks` (RECOMMENDED where the provider offers them)
   - Verified per Section 5.1(5). Events are queued, deduplicated by idempotency key, and applied
     in per-task order. Webhooks are treated as *hints*: on any doubt, re-read via the adapter.

2. `Polling`
   - Cursor-based incremental listing on a configured cadence. REQUIRED when webhooks are
     unavailable or unverified; RECOMMENDED as backstop even with webhooks.

3. `Reconciliation` (REQUIRED)
   - Scheduled job comparing linked tasks' current provider state against `baseSnapshot` and the
     linked issue. Repairs missed events, detects deletions/archivals, refreshes health
     timestamps. Reconciliation MUST be rate-bounded and incremental (cursor or rolling window);
     it MUST NOT re-read every link on every run for large installations.

### 7.2 State Mapping

Each connector instance MUST carry an explicit mapping from provider states/lanes to the
normalized categories:

- `backlog` — visible, not requesting execution.
- `active` — requesting execution (Symphony's "active states").
- `review` — provider-side human review/handoff.
- `blocked` — provider-side blocked indication, where representable.
- `terminal` — done/cancelled/archived.

Mapping rules:

- Mapping is configuration, validated at setup against live provider workflow metadata where
  available.
- Unmapped states MUST be treated as `backlog` (inert) and reported in health, never guessed.
- Category transitions drive issue effects per Section 7.4 and run effects per Section 9.3.

### 7.3 Comment Import and Provenance

- Imported comments MUST carry `ExternalActor` provenance and a deep link to the external comment
  where the provider supports it.
- Imported comment content is **untrusted input**: it MUST be clearly attributed in the issue
  thread, MUST NOT be interpreted as Paperclip system/agent instructions, and mention-like syntax
  MUST NOT trigger Paperclip mention semantics except via the strict command path (Section 8.2).
- Whether an imported comment wakes the issue assignee is link policy (`wakeOnExternalComment`,
  default true for `symphony_compatible`, false for `observer`).
- Comments authored by the connector's own service account MUST be suppressed on import
  (Section 10.4).

### 7.4 External State Transitions Against Paperclip Work

When the external task changes category:

- `backlog -> active`: create or wake per `runMode` (Section 9.3).
- `active -> backlog` or `active -> blocked`: the connector SHOULD surface this on the issue; under
  `symphony_compatible` it MUST make the issue ineligible for new tracker-driven dispatch and
  SHOULD request stop of tracker-driven runs (Section 9.3); Paperclip-native obligations
  (approvals in flight, blockers) are unaffected.
- `* -> terminal` while the Paperclip issue is active (checked out, running, in review, or carrying
  unresolved blockers/approvals): default is a **conflict**, not silent closure. The issue gets a
  comment naming the external actor and transition; the link enters `conflict` until an agent or
  operator resolves it. Auto-close MAY be enabled per link policy only when no active run, no
  pending review/approval, and no blockers exist.
- `terminal -> active` (reopen): if the linked issue is terminal, policy chooses between creating a
  follow-up Paperclip issue linked to the same external task (RECOMMENDED default) or reopening,
  subject to host rules for resuming closed issues.

External transitions MUST NOT directly set Paperclip issue status; they translate into host-level
requests that respect checkout, approvals, blockers, budget stops, and execution policy.

## 8. Agent Routing (Assignment Without External Agent Users)

External assignment intent resolves to a Paperclip assignee through an ordered pipeline. The first
matching enabled rule wins. Routing runs at import, and again whenever external assignment intent
changes (assignee change, label/field change, lane move, command comment).

### 8.1 Routing Pipeline

1. `comment_command` — strict slash command in an external comment (Section 8.2).
2. `custom_field` — provider custom field naming an agent (example: `Paperclip Agent = CodexCoder`).
3. `label` — namespaced label (example: `pc:agent/codexcoder`, `pc:route/qa`).
4. `state_lane` — provider state/lane mapped to a route (example: Trello list `Paperclip: QA`).
5. `user_mapping` — explicit external-user → agent mapping table (OPTIONAL; for teams that choose
   to create provider users for agents).
6. `default_route` — connector/project default (example: all imported tasks go to a triage agent
   or the CTO agent).

Requirements:

- Routing MUST resolve before the issue is created; every imported issue has an assignee.
- If no rule matches and no default route exists, the connector MUST assign the configured triage
  fallback and post a visible "unresolved routing" comment on both sides (external side only if
  write policy allows). Import MUST NOT be dropped silently.
- Routing targets are validated against the live company agent registry at apply time; routes to
  missing/paused agents fall through to triage with a health entry.
- Re-routing an issue that is checked out MUST NOT force-reassign; it posts a handoff request
  comment for the current owner (host reassignment rules apply).

### 8.2 Strict Comment Commands

Comment commands give external users explicit control without new UI in the provider.

- Syntax: line-anchored `/paperclip <verb> [args]`. Minimum verbs: `assign <agent>`,
  `status`, `pause`, `resume`. Connectors MAY add verbs; all verbs MUST be listed in capability
  metadata.
- Parsing MUST be deterministic connector code. An LLM MUST NOT infer intent from free text.
- The connector MUST reply (externally, if writes allowed; on the Paperclip issue otherwise) with
  the command outcome, including rejections (unknown agent, not permitted).
- Command authorization is implementation-defined but MUST be documented (e.g. any provider
  member vs. mapped users only).

### 8.3 Identity Model

- Paperclip agents MUST NOT be required to exist as provider users.
- Outbound writes use one connector service account per connector instance (Section 10.4), with
  agent attribution carried in message content ("CodexCoder via Paperclip").
- `user_mapping` rules MAY map specific provider users to Paperclip users (for `assign it back to
  me` flows) and to agents, but every such mapping is explicit configuration.

## 9. Execution Orchestration: Symphony Profile

This section defines how tracker-driven execution maps onto host primitives. It applies to links
with `runMode=symphony_compatible`; `paperclip_controlled` links use only Sections 9.4–9.5 advice.

### 9.1 Dispatch Model

Symphony's poll-tick loop becomes, in Paperclip:

1. Inbound sync (webhook/poll/reconcile) maintains link + normalized state.
2. For each link whose external category is `active` and whose linked issue is dispatchable
   (todo/backlog, not blocked, not awaiting approval), the connector ensures the issue is in the
   assignee's actionable queue (status `todo`) and wakes the assignee.
3. Host heartbeat scheduling — not the connector — decides actual run start, respecting company
   concurrency, budget, and execution policy. The connector MUST NOT spawn agent processes
   itself.

Bounded concurrency, dispatch ordering by priority, and per-issue serialization are host
responsibilities; the connector's job ends at "make the issue actionable and wake the right
agent."

### 9.2 Claim Semantics

- Paperclip issue checkout is the claim. One agent owns an issue at a time; checkout conflicts
  (409) mean the issue is already claimed.
- The connector MUST treat checkout state as authoritative and MUST NOT maintain a parallel claim
  registry for linked issues.
- Claim state SHOULD be projected outbound (Section 10.3) so external users can see that an agent
  has picked the task up.

### 9.3 Run Lifecycle, Retry, Release

Host-side equivalents of Symphony's run-attempt machine:

- `Running` — an active heartbeat run exists for the issue's assignee on this issue.
- `RetryQueued` — host recovery/scheduled wake exists (failed run recovery, blocked-resume,
  scheduled continuation).
- `Released` — issue reached terminal/review/blocked state, or the external task left `active`.

Profile requirements:

- When the external task leaves `active` during tracker-driven work, the connector MUST mark the
  link state accordingly and request run stop through host cancel/pause APIs; it MUST NOT kill
  processes directly.
- Failed runs follow host retry/recovery; the connector MUST NOT re-wake an issue in a tight loop
  (wake requests for the same link MUST be debounced, RECOMMENDED minimum 60s).
- A successful run that ends at `in_review`/handoff is a valid terminal outcome for the
  tracker-driven cycle (mirrors Symphony's `Human Review` boundary); the connector projects
  `review`, it does not force `terminal`.

### 9.4 Workspaces

Per-issue isolation is provided by host execution workspaces/worktrees keyed by issue. Links and
follow-up issues that must share a checkout use host workspace-inheritance
(`inheritExecutionWorkspaceFromIssueId`); the connector never manages filesystem workspaces.

### 9.5 Workflow Policy

Symphony's repository-owned `WORKFLOW.md` maps to a layered policy lookup for rendering the task
packet (Section 9.5.1) and run guidance:

1. Paperclip project workflow document (RECOMMENDED MVP form).
2. Repository `WORKFLOW.md` discovered in the project workspace (OPTIONAL, code projects).
3. Connector instance defaults.

Precedence and safety:

- Workflow policy is versioned project policy. It MAY shape prompts, validation steps, and
  handoff targets.
- Workflow policy MUST NOT override host system/company/agent instructions, governance gates, or
  this protocol's invariants. It is additive guidance, lowest precedence.

#### 9.5.1 Task Packet Rendering

Tracker-originated work MUST reach the agent as a rendered task packet, not raw provider text:

- Inputs: normalized `ExternalTask`, link metadata (backlink URL, sync/run mode), workflow policy,
  attempt/continuation context.
- The packet MUST mark external content as externally-authored untrusted input.
- The packet MUST include the external key/URL so agents can reference the source task in
  comments and PRs.
- Rendering MUST be strict: missing required variables fail the dispatch with a health entry
  rather than emitting a partial prompt.

### 9.6 Symphony Profile Conformance

A connector MAY claim "Symphony-compatible task source" when:

- Layers 1–3 are implemented.
- Active/terminal state mapping is explicit configuration (Section 7.2).
- Active external tasks create/wake issues without manual import, under operator-enabled policy.
- Checkout-as-claim is respected (Section 9.2) and external de-activation stops tracker-driven
  dispatch (Section 9.3).
- Per-issue execution uses host workspaces (Section 9.4).
- Workflow policy lookup is implemented for at least one source (Section 9.5).
- Claim/run/retry/release state is observable per link (Section 12).

## 10. Outbound Synchronization and Write Policy (Paperclip → External)

### 10.1 Write Boundary

All provider writes flow through the connector's Outbound Write Engine or connector-provided
agent tools. Host core logic MUST NOT write to providers. Agent tools that write externally are
connector tools with the same policy checks as engine writes. (This is Symphony's tracker-writes
boundary, kept.)

Every outbound write MUST be:

- Policy-checked against the link's `syncMode` and `fieldPolicy` and the write toggles below.
- Idempotent under the outbound idempotency key (Section 4.3).
- Attributed (Section 10.4) and audit-logged (Section 14.5).

### 10.2 Write Policy Toggles and Defaults

Per link (with connector-instance defaults):

| Toggle | Default | Meaning |
| --- | --- | --- |
| `postBacklink` | on | Paperclip URL on the external task (field or pinned comment). |
| `postProgressComments` | on | Concise milestone comments: claimed, plan ready, PR opened, review requested, done. |
| `postArtifactLinks` | on | PR/work-product/document links when produced. |
| `mirrorAgentComments` | off | Full Paperclip comment thread mirrored externally. |
| `postTranscripts` | off | Run logs/transcripts externally. SHOULD remain off; transcripts may contain sensitive context. |
| `projectStatus` | on | Status projection per Section 10.3. |
| `mirrorExternalComments` | on (import side) | External comments imported per Section 7.3. |

Progress comments MUST be concise and milestone-based, not per-heartbeat chatter. Connectors
SHOULD batch/debounce outbound comments (RECOMMENDED minimum interval 5 minutes per link except
for claim/done/review milestones).

### 10.3 Status Projection

Paperclip issue status projects to provider states through the same mapping table as Section 7.2,
inverted, with these rules:

- Projection only moves the external task between states the operator mapped; unmapped Paperclip
  statuses project as comments, not transitions.
- `in_review` projects to the mapped `review` state where one exists — the Symphony handoff
  pattern — otherwise stays in `active` with a review-requested comment.
- `done` projects to the mapped terminal state only when `fieldPolicy.state` permits
  Paperclip-side closure; otherwise it posts a completion comment and leaves the transition to
  external users.
- Claim/run state (claimed by which agent, running, retrying, released) SHOULD be projected into a
  custom field or status comment where the provider allows, so external users see liveness.

### 10.4 Attribution and Echo Suppression

- Outbound writes use the connector instance's service account. Message bodies MUST carry agent
  attribution and the Paperclip issue link.
- Inbound processing MUST drop events authored by the connector's own service account
  (`isConnectorServiceAccount`) **and** events matching a recently-issued outbound idempotency
  key, preventing echo loops with providers that obscure authorship.
- Mirrored content MUST be marked so a second connector instance never re-mirrors it (loop
  prevention across instances): a stable marker (hidden metadata or footer convention) is
  REQUIRED on all mirrored comments.

## 11. Conflict Detection and Resolution

### 11.1 Detection

Three-way comparison per synced field: `baseSnapshot` vs current external value vs current
Paperclip value.

- Changed on one side only → propagate per `fieldPolicy` (or queue conflict if the changed side
  is not the owner).
- Changed on both sides since base → conflict entry.
- Structural conflicts (Section 6.4 deletion, Section 7.4 terminal-while-active, routing failure)
  are first-class conflict kinds.

### 11.2 Conflict Entry

Fields: `linkId`, `kind` (`field`, `deletion`, `closure`, `routing`, `policy`), `field` (when
applicable), `baseValue`, `externalValue`, `paperclipValue`, `detectedAt`, `actors` (both sides
where known), `status` (`open`, `resolved`, `dismissed`), `resolution`.

### 11.3 Resolution Actions

Exposed in the conflict queue UI and as agent-invocable connector tools:

- `keep_paperclip` (push Paperclip value outbound)
- `keep_external` (apply external value inbound)
- `merge_manual` (operator/agent supplies the merged value)
- `unlink`
- `dismiss` (acknowledge without change; updates `baseSnapshot` to current values)

Resolving a conflict MUST update `baseSnapshot` so the same divergence is not re-detected. Open
conflicts MUST NOT block unrelated fields from syncing.

## 12. Observability and Health

### 12.1 Logging Conventions

Connector log entries MUST carry: `connectorInstanceId`, `providerKey`, `linkId` (when bound),
`externalTaskId`/`externalKey`, `issueId`/issue identifier, event kind, idempotency key, and
outcome. Plugin activity logging is the REQUIRED sink; additional sinks are
implementation-defined.

### 12.2 Health Surface (REQUIRED)

Per connector instance, operators MUST be able to see `ConnectorHealth` (Section 4.1.8) plus:

- cursor positions and lag estimates,
- inbound queue depth and oldest pending event age,
- scheduled retries with next-due times,
- open conflicts (count + queue link),
- last 50 sync errors with categories.

### 12.3 Link Surface (REQUIRED)

Per linked issue (issue-detail integration), users MUST be able to see: external key/title/URL and
current external state; sync and run mode; field ownership; the routing rule that selected the
assignee; last inbound/outbound/reconcile times; current claim/run/retry/release state; and
actions (open external, resync now, pause/resume, unlink, resolve conflict).

### 12.4 External-Side Surface (RECOMMENDED)

On the provider side, a linked task SHOULD show: the Paperclip backlink, current Paperclip
owner/status (field or comment), and concise progress per Section 10.2.

## 13. Failure Model and Recovery

### 13.1 Failure Classes

1. `Provider outage / transport failure` — retry with exponential backoff and jitter; health
   `degraded`; links untouched.
2. `Credential expiry` — health `error`, operator notification path REQUIRED; no link mutations.
3. `Webhook loss / delivery gaps` — repaired by polling backstop and reconciliation; this is why
   Section 7.1.3 is REQUIRED.
4. `Cursor loss/corruption` — bounded re-list with idempotent re-apply (Section 5.4).
5. `Rate limiting` — honor provider guidance; shed reconciliation load before shedding webhook
   processing; never drop queued inbound events on rate limits.
6. `Partial apply crash` — idempotency keys + transactional cursor persistence (Section 4.1.7)
   make re-apply safe.
7. `Poison event` — an event that repeatedly fails application is parked with a health entry after
   a bounded retry count (RECOMMENDED 5); it MUST NOT block the per-task queue forever.
8. `Provider schema drift` — unknown payload shapes degrade to `provider_payload` errors with the
   raw payload preserved for diagnosis; known-good fields continue to apply.

### 13.2 Restart Recovery

Connector restart recovery is cursor- and link-store-driven: re-verify webhook registration,
resume cursors, run one reconciliation pass. In-memory queue contents may be lost; reconciliation
repairs the gap. No durable orchestrator state beyond the link store and cursors is REQUIRED.

### 13.3 Operator Intervention Points

Operators MUST be able to: pause/resume a connector instance; pause/resume a single link; force
resync of a link; replay a parked event; rotate credentials; and unlink. All interventions are
audit-logged.

## 14. Security and Governance

### 14.1 Company Boundary

Every connector instance binds to exactly one company. Every inbound effect MUST resolve its
target company from the link/connector instance before any mutation, and MUST NOT cross
companies. Multi-company installations are separate connector instances with separate credentials
and state.

### 14.2 Credentials and Webhooks

- Provider tokens/OAuth grants MUST be stored as secret references, never inline configuration or
  plugin state.
- Webhook endpoints MUST verify provider signatures where offered; unverifiable webhook payloads
  are hints requiring API read-back (Section 5.1(5)).
- Webhook endpoints MUST reject payloads that do not match the connector instance's registered
  provider workspace.

### 14.3 Untrusted Content and Commands

- All external content (titles, descriptions, comments, field values, workflow files) is
  untrusted input with provenance, per Sections 7.3 and 9.5.1.
- Comment commands are parsed deterministically (Section 8.2); free-text external content MUST
  NOT trigger privileged actions.
- Workflow policy is lowest-precedence guidance (Section 9.5) — it cannot grant capabilities,
  alter governance, or override system instructions.

### 14.4 Governance Invariants

No connector path may bypass:

- issue checkout/claim exclusivity,
- budget hard-stops and pause/cancel,
- approval gates and execution-policy stages,
- blocker semantics,
- company boundaries.

External signals translate into host-level requests subject to all of the above (Section 7.4).
Destructive cascade is prohibited: external deletion/archival never deletes Paperclip work
(Section 6.4).

### 14.5 Audit

Every mutation on either side carries attribution: connector instance, link, triggering event
idempotency key, and acting identity (external actor inbound; agent + connector service account
outbound). Audit entries are queryable per link.

## 15. Reference Flows (Language-Agnostic)

### 15.1 Import One External Task

```
on import_request(externalTaskId):
  task = adapter.getTask(externalTaskId)
  if dedupe_hit(task): surface_existing_link(); stop
  company, project, goal = resolve_target(connector_instance)
  assignee = routing.resolve(task)            # Section 8; triage fallback guaranteed
  packet  = render_projection(task)           # normalized fields only
  issue   = host.create_issue(company, project, goal, assignee, packet,
                              source_attribution(task))
  link    = links.create(task, issue, originSide=external,
                         baseSnapshot=snapshot(task, issue))
  if policy.postBacklink: adapter.setBacklink(task.externalId, issue.url)
  health.record(inbound_ok)
```

### 15.2 Inbound Comment

```
on provider_comment_event(evt):
  evt = verify_or_readback(evt)
  if evt.actor.isConnectorServiceAccount or echo_match(evt): drop
  if not idempotency.first_time(evt): drop
  link = links.by_external(evt.externalTaskId) or stop
  if command = parse_strict_command(evt.body):    # Section 8.2
      execute_and_reply(command); record; stop
  host.post_issue_comment(link.issueId, attributed(evt))   # provenance, untrusted
  if link.policy.wakeOnExternalComment: host.wake_assignee(link.issueId)
```

### 15.3 Tracker-Driven Execution Cycle (Symphony Profile)

```
on external_state_change(task) where link.runMode == symphony_compatible:
  category = state_mapping(task.state)
  if category == active and issue_dispatchable(link.issueId):
      host.set_status(link.issueId, todo); host.wake_assignee(link.issueId)  # debounced
  if category in {backlog, blocked, terminal} and tracker_driven_run_active(link):
      host.request_stop(link.issueId)             # via cancel/pause APIs only
      if category == terminal and issue_active(link.issueId):
          conflicts.open(link, kind=closure)      # Section 7.4

on issue_status_change(issue) where linked(issue):
  outbound.project_status(link, issue.status)     # Section 10.3, policy-gated
  outbound.post_milestone_comment_if_due(link, issue)
```

### 15.4 Reconciliation Tick

```
every reconcile_interval per connector_instance:
  for link in links.window(cursor):               # rate-bounded slice
    state = adapter.getTaskStates([link.externalTaskId])
    if missing(state): conflicts.open(link, kind=deletion); continue
    diff = three_way(link.baseSnapshot, state, host.issue(link.issueId))
    apply_owned_changes(diff)                      # Section 11.1
    queue_conflicts(diff)
    link.lastReconcileAt = now
  health.record(reconcile_ok, cursor)
```

## 16. Conformance Checklist (Definition of Done)

### 16.1 REQUIRED for Core Conformance (Layers 1–2)

- Task Source Adapter with `listCandidateTasks`, `getTask`, `getTaskStates`, `listComments`,
  webhook verification or documented poll-only posture
- Static capability declaration consumed by host UX
- Normalized `ExternalTask` output with provider envelope separation
- Task link store with the Section 4.1.3 invariants and Section 6.1 state machine
- Idempotent inbound apply (event idempotency keys + transactional cursors)
- Deduplicated link creation (Section 6.3)
- External deletion handled non-destructively (Section 6.4)
- Explicit state-category mapping with unmapped-state safety (Section 7.2)
- Comment import with provenance and untrusted-content handling (Section 7.3)
- Routing pipeline with guaranteed triage fallback (Section 8)
- Reconciliation job (Section 7.1.3)
- Health and link surfaces (Sections 12.2, 12.3)
- Secret-ref credentials, company-boundary enforcement, audit attribution (Section 14)

### 16.2 REQUIRED for Symphony Profile Conformance (Layer 3)

- `runMode=symphony_compatible` honoring Section 9.1 dispatch (wake, never spawn)
- Checkout-as-claim with no parallel claim registry (Section 9.2)
- External de-activation stops tracker-driven dispatch via host APIs (Section 9.3)
- Debounced wake requests (Section 9.3)
- Task packet rendering with strict variables and untrusted marking (Section 9.5.1)
- Workflow policy lookup from at least one source with lowest-precedence guarantee (Section 9.5)
- Claim/run/retry/release state visible per link (Section 12.3)

### 16.3 REQUIRED for Write Conformance (Layer 4)

- Outbound writes only via Outbound Write Engine / connector tools (Section 10.1)
- Policy toggles with Section 10.2 defaults, including transcripts off
- Idempotent outbound effects
- Status projection rules including review-handoff and gated closure (Section 10.3)
- Service-account attribution, echo suppression, and cross-instance loop markers (Section 10.4)
- Three-way conflict detection with resolution actions and base-snapshot advance (Section 11)

### 16.4 RECOMMENDED Extensions (Not REQUIRED for Conformance)

- External-side claim/run state projection into provider custom fields
- `user_mapping` routing and "assign back to me" flows
- Lossless rich-text round-trip per provider
- Comment-command verb extensions (e.g. `/paperclip plan`, `/paperclip qa`)
- Promotion of task links from plugin state to core schema once two providers validate the model

## Appendix A. Provider Profiles

Each profile lists container coordinates, envelope content, state-mapping notes, and known write
constraints. Profiles are informative; the normative contract is Sections 4–14.

### A.1 Linear

- Containers: team, project, cycle. Envelope: issue key, workflow state id/type, labels with ids,
  branch name, relations, estimates, cycle/project ids.
- State mapping: Linear workflow state `type` (`backlog`, `unstarted`, `started`, `completed`,
  `canceled`) gives a reliable default category mapping; per-team overrides supported.
- Webhooks: signed; verification REQUIRED. API: GraphQL; pagination REQUIRED; keep queries
  isolated (schema drift).
- Notes: closest provider to the Symphony reference; RECOMMENDED first connector.

### A.2 Jira

- Containers: site/cloud id, project key. Envelope: issue type, workflow transition ids, status
  category, components, epic/parent links, sprints, custom fields by id.
- State mapping: map via Jira status categories (`To Do`, `In Progress`, `Done`) plus named-status
  overrides; transitions require transition ids, so `updateTaskState` resolves transitions at
  apply time.
- Webhooks: available (signed via secret on Cloud); polling backstop RECOMMENDED.
- Notes: per-project workflow variance is the main mapping risk; setup MUST validate against live
  workflow metadata.

### A.3 Asana

- Containers: workspace, project, section. Envelope: section memberships, custom fields,
  followers, multi-project memberships.
- State mapping: Asana has completion plus sections; map sections→categories per project;
  completion maps to `terminal`.
- Webhooks: handshake + HMAC signatures; verification REQUIRED.
- Notes: multi-project membership means one task can match several containers — the link binds to
  the connector instance's configured container.

### A.4 Notion

- Containers: database id. Envelope: property schema snapshot, select/status property values,
  relation properties, block-content references.
- State mapping: a designated status/select property maps to categories; databases without one
  are import/browse only (no Symphony profile).
- Webhooks: limited; polling with `last_edited_time` high-water mark is the primary channel.
- Notes: rich-text conversion is lossy; envelope SHOULD retain block references for backlinks.

### A.5 Trello

- Containers: board, list. Envelope: list id, checklists, members, power-up metadata, card
  position.
- State mapping: lists are lanes; map lists→categories (`Paperclip: QA` style lanes also drive
  `state_lane` routing).
- Webhooks: available with callback verification; signatures via content digest.
- Notes: no native blockers/priority; both normalize to null/empty with envelope passthrough.

### A.6 GitHub Issues

- Containers: repository (and optionally Projects v2). Envelope: labels, milestones, assignees,
  linked PR references, reactions.
- State mapping: open/closed plus label conventions or Projects v2 status field for richer
  categories.
- Webhooks: HMAC-signed; verification REQUIRED.
- Notes: PR linkage is first-class here; `postArtifactLinks` SHOULD use native cross-references.

## Appendix B. Symphony Spec Crosswalk

| Symphony SPEC.md section | This document |
| --- | --- |
| 1 Problem Statement | 1 |
| 2 Goals / Non-Goals | 2 |
| 3 System Overview | 3 |
| 4 Core Domain Model (Issue, Run Attempt, Retry Entry, Runtime State) | 4 (`ExternalTask`, `TaskLink`, host run state via 9.3) |
| 5 Workflow Specification (`WORKFLOW.md`) | 9.5 (layered workflow policy) |
| 6 Configuration Specification | connector instance configuration (3.4, 5.2, 7.2, 10.2) |
| 7 Orchestration State Machine | 6.1 (link), 9.3 (claim/run/retry/release on host primitives) |
| 8 Polling, Scheduling, Reconciliation | 7.1, 9.1, 15.4 |
| 9 Workspace Management and Safety | 9.4 (host execution workspaces) |
| 10 Agent Runner Protocol | host heartbeat runtime (out of scope here; see 9.1 boundary) |
| 11 Issue Tracker Integration Contract | 5 (Task Source Adapter contract) |
| 11.5 Tracker Writes boundary | 10.1 |
| 12 Prompt Construction | 9.5.1 (task packet rendering) |
| 13 Logging, Status, Observability | 12 |
| 14 Failure Model and Recovery | 13 |
| 15 Security and Operational Safety | 14 |
| 16 Reference Algorithms | 15 |
| 17–18 Test Matrix / Implementation Checklist | 16 |
| Appendix A SSH Worker | not applicable (host owns execution substrate) |

Differences are deliberate: Symphony assumes one tracker, one repo, and coding agents only, with
the orchestrator as a standalone daemon. This protocol assumes a multi-tenant control plane that
already owns claims, runs, workspaces, and governance — so the connector's scope shrinks to
normalization, linking, routing, sync policy, and observability, and Symphony's
orchestrator/runner sections collapse onto existing host primitives.
