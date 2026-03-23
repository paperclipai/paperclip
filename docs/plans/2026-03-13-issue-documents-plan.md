# Issue Documents Plan

Status: Draft  
Owner: Backend + UI + Agent Protocol  
Date: 2026-03-13  
Primary issue: `PAP-448`

## Summary

Add first-class **documents** to Paperclip as editable, revisioned, company-scoped text artifacts that can be linked to issues.

The first required convention is a document with key `plan`.

This solves the immediate workflow problem in `PAP-448`:

- plans should stop living inside issue descriptions as `<plan>` blocks
- agents and board users should be able to create/update issue documents directly
- `GET /api/issues/:id` should include the full `plan` document and expose the other available documents
- issue detail should render documents under the description

This should be built as the **text-document slice** of the broader artifact system, not as a replacement for attachments/assets.

## Recommended Product Shape

### Documents vs attachments vs artifacts

- **Documents**: editable text content with stable keys and revision history.
- **Attachments**: uploaded/generated opaque files backed by storage (`assets` + `issue_attachments`).
- **Artifacts**: later umbrella/read-model that can unify documents, attachments, previews, and workspace files.

Recommendation:

- implement **issue documents now**
- keep existing attachments as-is
- defer full artifact unification until there is a second real consumer beyond issue documents + attachments

This keeps `PAP-448` focused while still fitting the larger artifact direction.

## Goals

1. Give issues first-class keyed documents, starting with `plan`.
2. Make documents editable by board users and same-company agents with issue access.
3. Preserve change history with append-only revisions.
4. Make the `plan` document automatically available in the normal issue fetch used by agents/heartbeats.
5. Replace the current `<plan>`-in-description convention in skills/docs.
6. Keep the design compatible with a future artifact/deliverables layer.

## Non-Goals

- full collaborative doc editing
- binary-file version history
- browser IDE or workspace editor
- full artifact-system implementation in the same change
- generalized polymorphic relations for every entity type on day one

## Product Decisions

### 1. Keyed issue documents

Each issue can have multiple documents. Each document relation has a stable key:

- `plan`
- `design`
- `notes`
- `report`
- custom keys later

Key rules:

- unique per issue, case-insensitive
- normalized to lowercase slug form
- machine-oriented and stable
- title is separate and user-facing

The `plan` key is conventional and reserved by Paperclip workflow/docs.

### 2. Text-first v1

V1 documents should be text-first, not arbitrary blobs.

Recommended supported formats:

- `markdown`
- `plain_text`
- `json`
- `html`

Recommendation:

- optimize UI for `markdown`
- allow raw editing for the others
- keep PDFs/images/CSVs/etc as attachments/artifacts, not editable documents

### 3. Revision model

Every document update creates a new immutable revision.

The current document row stores the latest snapshot for fast reads.

### 4. Concurrency model

Do not use silent last-write-wins.

Updates should include `baseRevisionId`:

- create: no base revision required
- update: `baseRevisionId` must match current latest revision
- mismatch: return `409 Conflict`

This is important because both board users and agents may edit the same document.

### 5. Issue fetch behavior

`GET /api/issues/:id` should include:

- full `planDocument` when a `plan` document exists
- `documentSummaries` for all linked documents

It should not inline every document body by default.

This keeps issue fetches useful for agents without making every issue payload unbounded.

### 6. Legacy `<plan>` compatibility

If an issue has no `plan` document but its description contains a legacy `<plan>` block:

- expose that as a legacy read-only fallback in API/UI
- mark it as legacy/synthetic
- prefer a real `plan` document when both exist

Recommendation:

- do not auto-rewrite old issue descriptions in the first rollout
- provide an explicit import/migrate path later

## Proposed Data Model

Recommendation: make documents first-class, but keep issue linkage explicit via a join table.

This preserves foreign keys today and gives a clean path to future `project_documents` or `company_documents` tables later.

## Tables

### `documents`

Canonical text document record.

Suggested columns:

- `id`
- `company_id`
- `title`
- `format`
- `latest_body`
- `latest_revision_id`
- `latest_revision_number`
- `created_by_agent_id`
- `created_by_user_id`
- `updated_by_agent_id`
- `updated_by_user_id`
- `created_at`
- `updated_at`

### `document_revisions`

Append-only history.

Suggested columns:

- `id`
- `company_id`
- `document_id`
- `revision_number`
- `body`
- `change_summary`
- `created_by_agent_id`
- `created_by_user_id`
- `created_at`

Constraints:

- unique `(document_id, revision_number)`

### `issue_documents`

Issue relation + workflow key.

Suggested columns:

- `id`
- `company_id`
- `issue_id`
- `document_id`
- `key`
- `created_at`
- `updated_at`

Constraints:

- unique `(company_id, issue_id, key)`
- unique `(document_id)` to keep one issue relation per document in v1

## Why not use `assets` for this?

Because `assets` solves blob storage, not:

- stable keyed semantics like `plan`
- inline text editing
- revision history
- optimistic concurrency
- cheap inclusion in `GET /issues/:id`

Documents and attachments should remain separate primitives, then meet later in a deliverables/artifact read-model.

## Shared Types and API Contract

## New shared types

Add:

- `DocumentFormat`
- `IssueDocument`
- `IssueDocumentSummary`
- `DocumentRevision`

Recommended `IssueDocument` shape:

```ts
type DocumentFormat = "markdown" | "plain_text" | "json" | "html";

interface IssueDocument {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  body: string;
  latestRevisionId: string;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

Recommended `IssueDocumentSummary` shape:

```ts
interface IssueDocumentSummary {
  id: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string;
  latestRevisionNumber: number;
  updatedAt: Date;
}
```

## Issue type enrichment

Extend `Issue` with:

```ts
interface Issue {
  ...
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: {
    key: "plan";
    body: string;
    source: "issue_description";
  } | null;
}
```

This directly satisfies the `PAP-448` requirement for heartbeat/API issue fetches.

## API endpoints

Recommended endpoints:

- `GET /api/issues/:issueId/documents`
- `GET /api/issues/:issueId/documents/:key`
- `PUT /api/issues/:issueId/documents/:key`
- `GET /api/issues/:issueId/documents/:key/revisions`
- `DELETE /api/issues/:issueId/documents/:key` optionally board-only in v1

Recommended `PUT` body:

```ts
{
  title?: string | null;
  format: "markdown" | "plain_text" | "json" | "html";
  body: string;
  changeSummary?: string | null;
  baseRevisionId?: string | null;
}
```

Behavior:

- missing document + no `baseRevisionId`: create
- existing document + matching `baseRevisionId`: update
- existing document + stale `baseRevisionId`: `409`

## Authorization and invariants

- all document records are company-scoped
- issue relation must belong to same company
- board access follows existing issue access rules
- agent access follows existing same-company issue access rules
- every mutation writes activity log entries

Recommended delete rule for v1:

- board can delete documents
- agents can create/update, but not delete

That keeps automated systems from removing canonical docs too easily.

## UI Plan

## Issue detail

Add a new **Documents** section directly under the issue description.

Recommended behavior:

- show `plan` first when present
- show other documents below it
- render a gist-like header:
  - key
  - title
  - last updated metadata
  - revision number
- support inline edit
- support create new document by key
- support revision history drawer or sheet

Recommended presentation order:

1. Description
2. Documents
3. Attachments
4. Comments / activity / sub-issues

This matches the request that documents live under the description while still leaving attachments available.

## Editing UX

Recommendation:

- use markdown preview + raw edit toggle for markdown docs
- use raw textarea editor for non-markdown docs in v1
- show explicit save conflicts on `409`
- show a clear empty state: "No documents yet"

## Legacy plan rendering

If there is no stored `plan` document but legacy `<plan>` exists:

- show it in the Documents section
- mark it `Legacy plan from description`
- offer create/import in a later pass

## Agent Protocol and Skills

Update the Paperclip agent workflow so planning no longer edits the issue description.

Required changes:

- update `skills/paperclip/SKILL.md`
- replace the `<plan>` instructions with document creation/update instructions
- document the new endpoints in `docs/api/issues.md`
- update any internal planning docs that still teach inline `<plan>` blocks

New rule:

- when asked to make a plan for an issue, create or update the issue document with key `plan`
- leave a comment that the plan document was created/updated
- do not mark the issue done

## Relationship to the Artifact Plan

This work should explicitly feed the broader artifact/deliverables direction.

Recommendation:

- keep documents as their own primitive in this change
- add `document` to any future `ArtifactKind`
- later build a deliverables read-model that aggregates:
  - issue documents
  - issue attachments
  - preview URLs
  - workspace-file references

The artifact proposal currently has no explicit `document` kind. It should.

Recommended future shape:

```ts
type ArtifactKind =
  | "document"
  | "attachment"
  | "workspace_file"
  | "preview"
  | "report_link";
```

## Implementation Phases

## Phase 1: Shared contract and schema

Files:

- `packages/db/src/schema/documents.ts`
- `packages/db/src/schema/document_revisions.ts`
- `packages/db/src/schema/issue_documents.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/migrations/*`
- `packages/shared/src/types/issue.ts`
- `packages/shared/src/validators/issue.ts` or new document validator file
- `packages/shared/src/index.ts`

Acceptance:

- schema enforces one key per issue
- revisions are append-only
- shared types expose plan/document fields on issue fetch

## Phase 2: Server services and routes

Files:

- `server/src/services/issues.ts` or `server/src/services/documents.ts`
- `server/src/routes/issues.ts`
- `server/src/services/activity.ts` callsites

Behavior:

- list/get/upsert/delete documents
- revision listing
- `GET /issues/:id` returns `planDocument` + `documentSummaries`
- company boundary checks match issue routes

Acceptance:

- agents and board can fetch/update same-company issue documents
- stale edits return `409`
- activity timeline shows document changes

## Phase 3: UI issue documents surface

Files:

- `ui/src/api/issues.ts`
- `ui/src/lib/queryKeys.ts`
- `ui/src/pages/IssueDetail.tsx`
- new reusable document UI component if needed

Behavior:

- render plan + documents under description
- create/update by key
- open revision history
- show conflicts/errors clearly

Acceptance:

- board can create a `plan` doc from issue detail
- updated plan appears immediately
- issue detail no longer depends on description-embedded `<plan>`

## Phase 4: Skills/docs migration

Files:

- `skills/paperclip/SKILL.md`
- `docs/api/issues.md`
- `doc/SPEC-implementation.md`
- relevant plan/docs that mention `<plan>`

Acceptance:

- planning guidance references issue documents, not inline issue description tags
- API docs describe the new document endpoints and issue payload additions

## Phase 5: Legacy compatibility and follow-up

Behavior:

- read legacy `<plan>` blocks as fallback
- optionally add explicit import/migration command later

Follow-up, not required for first merge:

- deliverables/artifact read-model
- project/company documents
- comment-linked documents
- diff view between revisions

## Test Plan

### Server

- document create/read/update/delete lifecycle
- revision numbering
- `baseRevisionId` conflict handling
- company boundary enforcement
- agent vs board authorization
- issue fetch includes `planDocument` and document summaries
- legacy `<plan>` fallback behavior
- activity log mutation coverage

### UI

- issue detail shows plan document
- create/update flows invalidate queries correctly
- conflict and validation errors are surfaced
- legacy plan fallback renders correctly

### Verification

Run before implementation is declared complete:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

## Open Questions

1. Should v1 documents be markdown-only, with `json/html/plain_text` deferred?
   Recommendation: allow all four in API, optimize UI for markdown only.

2. Should agents be allowed to create arbitrary keys, or only conventional keys?
   Recommendation: allow arbitrary keys with normalized validation; reserve `plan` as special behavior only.

3. Should delete exist in v1?
   Recommendation: yes, but board-only.

4. Should legacy `<plan>` blocks ever be auto-migrated?
   Recommendation: no automatic mutation in the first rollout.

5. Should documents appear inside a future Deliverables section or remain a top-level Issue section?
   Recommendation: keep a dedicated Documents section now; later also expose them in Deliverables if an aggregated artifact view is added.

## Final Recommendation

Ship **issue documents** as a focused, text-first primitive now.

Do not try to solve full artifact unification in the same implementation.

Use:

- first-class document tables
- issue-level keyed linkage
- append-only revisions
- `planDocument` embedded in normal issue fetches
- legacy `<plan>` fallback
- skill/docs migration away from description-embedded plans

This addresses the real planning workflow problem immediately and leaves the artifact system room to grow cleanly afterward.
