# Truth Runtime Schema Direction

Date: 2026-04-25
Status: Approved design direction
Decision: C-pragmatic

## 1. Decision

Paperclip should ship the simplified Liberty-equivalent truth runtime first:

```text
Atom -> Audit -> Brief -> Dossier
```

The Claim layer is deferred to Phase 1.5. The full ProposalForge
Evidence -> Claim -> Brief -> Export model remains valid long-term product
context, but it must not be rushed into the first nightly/API implementation.

This direction keeps the first mojoOS runtime small enough to ship, preserves
the evidence-bound behavior proven by the Liberty inspection work, and leaves a
clean expansion point for claims once the runtime path is stable.

## 2. Context

The current Paperclip repo already contains first-party truth plugins:

- `plugin-truth-extract-example`, a thin binding to ProposalForge Layer B.
- `plugin-truth-graph-example`, a read-only graph view for Layer A ledgers.
- `skills/paperclip-truth-extract`, the frozen Layer A atom extraction skill.

Those artifacts were deliberately conservative around the 2026-04-30 filing
window: Paperclip called ProposalForge instead of re-authoring its full truth
pipeline. The new runtime direction is narrower than ProposalForge, not a fork
of its complete schema. The runtime should own the minimum durable records
needed for nightly ingestion, audits, briefs, dossiers, and promotion gates.

## 3. Alternatives Considered

### A. Full ProposalForge Model Now

This would bring the full Claim, Brief, Export, synthesis-run, relation, and
evidence-link model into the nightly/API work immediately. It maximizes
theoretical completeness, but it also pulls the most complex and least-proven
parts of the pipeline into the critical path.

Rejected for this phase. It risks delaying the first runtime and creating a
second active implementation of the ProposalForge IP chain.

### B. Atoms and Dossiers Only

This would store extracted atoms and rendered dossiers, with minimal audit and
promotion lifecycle state. It is the fastest path, but it under-specifies the
parts that make the runtime trustworthy: audit findings, approval lifecycle,
mapping confidence, and prompt/template lineage.

Rejected for this phase. It is too thin for governed runtime use.

### C. Pragmatic Runtime Path

This stores evidence atoms, real audit rows, evidence-bound briefs, rendered
dossiers, promotion requests, and explicit document/chunk processing states. It
does not introduce Claim or export-version tables yet.

Approved. This is the V1 runtime path.

## 4. Scope

### In Scope

- Stable document and chunk identity for nightly ingestion.
- Separate document ingest, embedding, exclusion, and company-mapping states.
- Evidence atoms with transcript/source lineage.
- Real `truth_run_audits` rows for hallucination, omission, coverage, and
  integrity checks.
- Evidence-bound `truth_briefs` generated directly from accepted atoms and
  audit context.
- `truth_dossiers` linked to both `truth_runs` and `truth_briefs`.
- `truth_promotion_requests` with full approval, rejection, completion, and
  failure lifecycle fields.
- JSON `allowed_company_slugs` on V1 auth records.

### Out of Scope

- Claim tables.
- Claim evidence pivot tables.
- Claim relation graphs.
- `truth_export_versions`.
- Immutable export/freeze semantics.
- Full ProposalForge release gates.

Those belong to Phase 1.5 or later.

## 5. Schema Direction

All runtime tables must be company-scoped. Where both `company_id` and
`company_slug` are present, `company_id` is the authoritative internal foreign
key and `company_slug` is the stable operator-facing/runtime mapping key.

### 5.1 `truth_documents`

Do not overload Paperclip's existing editable `documents` table, which stores
issue documents with `latest_body` and revision semantics. Truth ingestion has
a different lifecycle and should use a separate `truth_documents` table.

Do not use a single `processing_status` field to hide unrelated states. Create
truth document records with separate status columns:

- `company_id` uuid not null
- `company_slug` text not null
- `title` text null
- `source_type` text not null
- `source_uri` text null
- `source_sha256` char(64) null
- `ingest_status` text not null
- `embedding_status` text not null
- `exclusion_status` text not null
- `mapping_confidence` numeric null
- `mapping_reason` text null
- `metadata` jsonb not null default `{}`

Recommended status values:

- `ingest_status`: `pending | running | succeeded | failed`
- `embedding_status`: `not_required | pending | running | succeeded | failed`
- `exclusion_status`: `included | excluded | pending_review`

Indexes:

- unique where appropriate on `(company_id, source_sha256)`
- index on `(company_id, ingest_status)`
- index on `(company_id, embedding_status)`
- index on `(company_slug, mapping_confidence)`

### 5.2 `truth_document_chunks` / existing `document_chunks`

For a new Paperclip implementation, use `truth_document_chunks` so truth
runtime chunks do not collide with unrelated document features. If an existing
runtime database already has a table named `document_chunks`, the same identity
migration rules apply.

Do not mutate existing chunk `id` values in place.

If a `document_chunks` table already exists in an environment, add stable keys
first and backfill them before changing new-write behavior:

- `source_chunk_key` text not null after backfill
- `deterministic_key` text not null after backfill

For new chunks going forward, use UUIDv5 for `id`:

```text
id = uuidv5(TRUTH_CHUNK_NAMESPACE, deterministic_key)
```

The deterministic key should be a canonical string built from stable source
inputs, for example:

```text
company_slug/document_source_key/chunk_kind/source_utterance_id_or_span/content_sha256
```

Required indexes:

- unique `(company_id, source_chunk_key)`
- unique `(company_id, deterministic_key)`
- index `(company_id, truth_document_id)`

Backfill rules:

- Add nullable columns first.
- Backfill `source_chunk_key` and `deterministic_key` in batches.
- Add unique indexes only after duplicate analysis is clean.
- Do not rewrite existing primary keys or foreign keys.
- Switch new chunk creation to UUIDv5 only after the keys are enforced.

### 5.3 `truth_runs`

One row per extraction/runtime run:

- `id` uuid pk
- `company_id` uuid not null
- `company_slug` text not null
- `truth_document_id` uuid not null
- `status` text not null
- `title` text null
- `extraction_version` text not null
- `prompt_version` text not null
- `model` text null
- `source_counts` jsonb not null default `{}`
- `started_at` timestamptz null
- `completed_at` timestamptz null
- `failed_at` timestamptz null
- `failure_reason` text null
- `metadata` jsonb not null default `{}`

Recommended statuses:

- `pending | running | needs_review | accepted | failed | superseded`

### 5.4 `truth_atoms`

The atom layer is the evidence layer. Atoms should stay close to the frozen
Layer A schema:

- `id` uuid pk
- `company_id` uuid not null
- `truth_run_id` uuid not null
- `truth_document_id` uuid not null
- `truth_document_chunk_id` uuid null
- `raw_atom_id` text null
- `atom_index` integer not null
- `ledger_section` text not null
- `atom_type` text not null
- `atom_text` text not null
- `durability_score` integer not null
- `confidence_score` numeric not null
- `evidence_mode` text not null
- `speaker_name` text null
- `speaker_id` text null
- `start_time` text null
- `end_time` text null
- `source_utterance_ids` jsonb not null default `[]`
- `evidence_quote` text not null
- `planning_relevance` text null
- `status` text not null
- `audit_flags` jsonb not null default `{}`
- `metadata` jsonb not null default `{}`

Recommended `ledger_section` values:

- `truth | context | noise | open_question | risk`

Recommended atom statuses:

- `needs_review | accepted | rejected | superseded`

### 5.5 `truth_run_audits`

Audits must be real rows, not only JSON metadata on `truth_runs`.

- `id` uuid pk
- `company_id` uuid not null
- `truth_run_id` uuid not null
- `audit_type` text not null
- `status` text not null
- `auditor_model` text null
- `prompt_version` text not null
- `template_version` text null
- `finding_count` integer not null default 0
- `summary` text null
- `findings` jsonb not null default `[]`
- `started_at` timestamptz null
- `completed_at` timestamptz null
- `failed_at` timestamptz null
- `failure_reason` text null

Recommended `audit_type` values:

- `hallucination | omission | coverage | integrity`

### 5.6 `truth_briefs`

For this phase, briefs are evidence-bound directly to accepted atoms and audit
context. They do not require a Claim layer.

- `id` uuid pk
- `company_id` uuid not null
- `truth_run_id` uuid not null
- `title` text not null
- `status` text not null
- `brief_kind` text not null
- `content_markdown` text null
- `content_json` jsonb null
- `canonical_input` jsonb not null
- `prompt_version` text not null
- `template_version` text not null
- `model` text null
- `input_hash` char(64) not null
- `payload_hash` char(64) null
- `created_by_agent_id` uuid null
- `created_by_user_id` text null
- `reviewed_at` timestamptz null
- `reviewed_by` text null
- `rejection_reason` text null

Recommended statuses:

- `draft | needs_review | accepted | rejected | superseded`

Brief evidence binding rule:

- `canonical_input` must contain the exact accepted atom IDs, audit IDs,
  prompt inputs, and template variables used to generate the brief.
- `input_hash` must be the SHA-256 hash of the canonical JSON serialization of
  `canonical_input`.
- A brief is not evidence-bound unless every referenced atom and audit row
  belongs to the same `company_id` and `truth_run_id`.
- An accepted or promoted brief must have either `content_markdown` or
  `content_json` and a non-null `payload_hash`.
- Accepted briefs are immutable. Any regenerated brief creates a new row and
  supersedes the prior row instead of mutating accepted content.

### 5.7 `truth_dossiers`

Dossiers are inspectable runtime artifacts. Store enough lineage for a reader
to tie a rendered dossier back to the exact brief and run:

- `id` uuid pk
- `company_id` uuid not null
- `truth_run_id` uuid not null
- `brief_id` uuid not null
- `title` text not null
- `status` text not null
- `html_content` text null
- `file_path` text null
- `content_sha256` char(64) null
- `brief_input_hash` char(64) not null
- `brief_payload_hash` char(64) not null
- `prompt_version` text not null
- `template_version` text not null
- `generated_at` timestamptz not null
- `generated_by_agent_id` uuid null
- `generated_by_user_id` text null
- `metadata` jsonb not null default `{}`

At least one of `html_content` or `file_path` must be present. Store
`html_content` when the artifact is small enough for normal DB handling; use
`file_path` for larger local files or object-storage-backed artifacts.
`brief_input_hash` and `brief_payload_hash` snapshot the exact accepted brief
used at render time.

Recommended statuses:

- `draft | ready | published | superseded | failed`

### 5.8 `truth_promotion_requests`

Promotion requests are the gate between generated truth artifacts and runtime
use by nightly/API flows.

Required fields:

- `id` uuid pk
- `company_id` uuid not null
- `company_slug` text not null
- `truth_run_id` uuid null
- `brief_id` uuid null
- `dossier_id` uuid null
- `requested_by` text not null
- `request_reason` text null
- `status` text not null
- `expires_at` timestamptz null
- `approved_at` timestamptz null
- `approved_by` text null
- `rejected_at` timestamptz null
- `rejection_reason` text null
- `completed_at` timestamptz null
- `failed_at` timestamptz null
- `failure_reason` text null
- `metadata` jsonb not null default `{}`

Recommended statuses:

- `pending | approved | rejected | completed | failed | expired`

Runtime rules:

- At least one of `truth_run_id`, `brief_id`, or `dossier_id` must be present.
- Runtime exposure completion requires `brief_id` or `dossier_id`; a
  `truth_run_id`-only request can approve run acceptance/review state, but it
  cannot complete promotion of a runtime artifact.
- If `dossier_id` is present, its `brief_id` and `truth_run_id` are the
  authoritative promotion target lineage.
- If `brief_id` is present without `dossier_id`, it must belong to
  `truth_run_id` when both are present.
- Every populated target must belong to the same `company_id`.
- A `brief_id` target is promotable only when the brief status is `accepted`,
  the brief is not superseded, and the brief has required content plus
  `input_hash` and `payload_hash`.
- A `dossier_id` target is promotable only when the dossier status is `ready`
  or `published`, the dossier is not superseded or failed, and its linked
  brief is promotable.
- A request cannot complete unless it was approved.
- A request cannot complete after `expires_at`.
- Rejections must include `rejection_reason`.
- Failures must include `failure_reason`.

### 5.9 Auth Company Allowances

Auth tables are conceptually right, but V1 should store allowed companies as
JSON on the credential-bearing auth records that authorize runtime/API access:

- `allowed_company_slugs` jsonb not null default `[]`

For V1, this field belongs on board API keys, agent/runtime API keys, and any
non-session service credential records. Human user access should continue to
use the existing membership/role model; do not copy company grants onto
ephemeral sessions.

Normalize to a join table later only if there is clear operational need for
grant/revoke history, per-company role metadata, or indexed administrative
queries beyond the V1 workload.

## 6. Nightly/API Behavior

The first nightly/API runtime must read from the simplified runtime path:

1. Ingest or update `truth_documents`.
2. Create stable `truth_document_chunks`.
3. Run extraction into `truth_runs` and `truth_atoms`.
4. Write audit records into `truth_run_audits`.
5. Generate `truth_briefs` directly from accepted atoms and audit context.
6. Render `truth_dossiers`.
7. Require an approved, unexpired `truth_promotion_requests` row before
   exposing a dossier/brief to promoted runtime consumers.

The runtime must not depend on Claim-layer tables in this phase.

## 7. IP Filing Guidance

For IP strategy, engineering should preserve options rather than force a
schema decision:

- Counsel can decide whether the Liberty evidence-bound brief is sufficient.
- Counsel can decide whether to add a small Claim-layer exhibit.
- Counsel can decide whether to move the filing date.

The engineering schema should not rush the full ProposalForge claim/export
model solely to satisfy the first nightly/API runtime.

## 8. Phase 1.5 Expansion Point

Phase 1.5 may add a small Claim layer if needed:

- `truth_claims`
- `truth_claim_evidence`
- optional `truth_claim_relations`

If added, claims should attach to accepted atoms and then briefs can cite
accepted claims instead of direct atoms. This must be an additive migration:
existing Atom -> Audit -> Brief -> Dossier runs remain valid.

`truth_export_versions` remains out of scope until the export/freeze layer is
explicitly prioritized.

## 9. Testing Expectations

Schema and service implementation should verify:

- Company isolation on every truth runtime table.
- Deterministic chunk key uniqueness.
- UUIDv5 creation for new chunks without rewriting existing IDs.
- Independent truth document status transitions for ingest, embedding, and
  exclusion.
- Promotion lifecycle transitions, including expiry and failure.
- Dossier lineage to both `brief_id` and `truth_run_id`.
- Audit rows are queryable independently from `truth_runs.metadata`.
- No V1 runtime code requires Claim-layer or `truth_export_versions` tables.

## 10. Summary

C-pragmatic is the approved path. Ship the Liberty-equivalent runtime now:
Atom -> Audit -> Brief -> Dossier. Keep it company-scoped, evidence-bound,
auditable, and versioned. Add Claim later without corrupting the simple path.
