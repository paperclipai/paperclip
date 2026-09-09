# Intake Triage Queue Proposal

Status: proposal. No code changes. Seeks maintainer direction before any
Path-2 implementation work.

## Context

Repeatable inputs arrive continuously: support requests, Linear/Jira/Asana
tickets, emails, form fills, routine findings. Today each such input either
becomes a live governed issue immediately or has nowhere to go. There is no
holding pen where inputs wait for a human or agent triage decision. Plane
answers this with per-project Intake inboxes: external items land as
triage-state issues (pending, accepted, rejected, snoozed, duplicate) with
source provenance, and only accepted work enters execution. This proposal
ports that staging layer to Paperclip's issue model.

## What We Know Today

- Issues already carry provenance: `originKind`, `originId`, and
  `originFingerprint` on `issues` (`packages/db/src/schema/issues.ts`) with
  a dedup index, plus create-time duplicate detection
  (`recent_open_title`, idempotency keys in `server/src/services/issues.ts`).
  External items can already enter with identity.
- Scoped ingestion transport is emerging: the intake-receiver API key scope
  (#10273, open) permits fixed-shape issue creation in one configured
  project with ownership tagging and replay protection. The connector
  playbook (`doc/connections/CONNECTOR-PLAYBOOK.md`) governs new
  integrations.
- Review surfaces exist but assume live work: the inbox shows assigned and
  blocked issues, approvals gate governed actions, and routines cover
  recurring work. None stages un-triaged inputs.
- Issue statuses (`backlog`, `todo`, `in_progress`, `in_review`, `done`,
  `blocked`, `cancelled` in `packages/shared/src/constants.ts`) drive
  orchestration (wakes, locks, monitors). Overloading them with triage
  states would ripple through heartbeat scheduling and execution guards.
- Prior art studied in Plane (`apps/api/plane/db/models/intake.py`):
  - `Intake`: named inbox per project with a default flag.
  - `IntakeIssue`: triage status (pending, rejected, snoozed, accepted,
    duplicate), `snoozed_till`, `duplicate_to` link, source tracking
    (`source`, `source_email`, `external_source`, `external_id`, `extra`).
  - Triage is a state machine on the intake link, not on the issue's
    workflow state. Accepted work proceeds; the rest stays staged.

## The Gap

Transport (receivers, provenance) and review (inbox, approvals) both exist,
but nothing between them stages inputs. Consequences: every external item
is born as live work that can wake agents and consume budget before anyone
agrees it matters; deferring means ad-hoc statuses or comments; duplicates
across sources have no first-class marking. The roadmap asks for exactly
this layer twice: Work Queues (queue-style streams for support, triage,
review, backlog intake) and Bring-your-own-ticket-system (Asana, Linear,
Jira as on-ramps while Paperclip owns execution).

## Goals

1. Give every project an intake holding pen where external and recurring
   inputs wait as triage-pending issues with source provenance.
2. Provide accept, decline, snooze, and mark-duplicate transitions with
   activity attribution, so triage decisions are auditable.
3. Keep triage state separate from workflow status so heartbeat scheduling,
   locks, and monitors never see un-triaged work.
4. Make routines and agents able to file into intake, and let accepted items
   flow into the existing execution lifecycle unchanged.

## Non-Goals

- Building Linear/Jira/Asana connectors here. On-ramps follow the
  connector playbook onto the intake API this proposal defines.
- Email ingestion, web forms, or chatbot front-ends. Those are producers
  of intake items, not the queue itself.
- Replacing inbox, approvals, or routines. Intake feeds them.
- Automatic triage decisions. Human or governed-agent accept/decline only;
  auto-triage is a later proposal if ever.

## Proposed Model

### Phase 1: triage state + transitions (schema + service, no UI)

- New `issue_intake` table (company scope): `issueId` (unique, FK cascade),
  `projectId`, triage status (`pending`, `accepted`, `rejected`,
  `snoozed`, `duplicate`), `snoozedTill`, `duplicateOfIssueId` (nullable FK),
  source fields (`source`, `externalSource`, `externalId`, `extra` JSONB),
  timestamps. New issues created through intake-designated paths start
  `pending`; all other creates are unaffected.
- Transitions (`accept`, `decline`, `snooze`, `mark_duplicate`) as service
  operations with actor attribution and activity entries. Accept keeps the
  issue's workflow status flow untouched. Snooze sets `snoozedTill` and
  hides the row until then. Duplicates link, never merge, so no data is
  destroyed.
- Scheduling guard: heartbeat wakes skip triage-pending issues (one
  predicate at wakeup selection, mirroring existing status guards), so
  staged work burns no budget.
- Migration is additive (new table only). No existing column changes.

### Phase 2: intake queue surface (API + UI)

- Read API: per-project intake queue (pending first, then snoozed-due),
  reusing inbox filter and pagination idioms.
- UI: an intake tab reusing inbox row and filter patterns, with
  accept/decline/snooze/duplicate actions and the standard dismissal
  affordances. Propose placing it beside the inbox, not inside it, so
  triage load stays visible separately from owned work.
- Counts surface where operators already look (sidebar badge, project
  headers) following the existing badge patterns.

### Phase 3: on-ramps (follow-ups, one per source)

- A scoped intake receiver endpoint creating triage-pending issues with
  origin provenance, building on #10273's key scope.
- Routines gain an intake-filing step type so recurring findings (reports,
  scans, reviews) land as triage items instead of live issues.
- Linear/Jira/Asana connectors per the connector playbook, each mapping
  external states onto the triage machine.

## Open Questions for Maintainers

1. Triage as a link table (proposed) versus new workflow statuses: is the
   scheduling-guard predicate the right seam, or should pending issues be
   invisible to wakes some other way?
2. Should every project get a default intake automatically, or only on
   demand (Plane uses a default flag)?
3. Who may triage: board operators only, or also governed agents (which
   policies)?
4. Should accept assign an owner, or leave assignment to existing routing?
5. Do snoozed items need wakeups on expiry, or is queue visibility enough?
6. Duplicate handling: link-only (proposed) or merge histories?

## Risks

- A second issue lifecycle running beside workflow status can confuse
  operators. Mitigation: triage states never overlap status values, the
  queue is visually separate, and activity entries narrate every
  transition.
- Un-triaged buildup if nobody watches a queue. Mitigation: per-project
  counts in existing badge surfaces plus routine-generated triage digests
  as a later step.
- External duplication across sources. Mitigation: origin fingerprint
  dedup at create plus explicit duplicate marking.

## Alternatives Considered

- New workflow statuses for triage (e.g. `pending_triage`). Rejected:
  status drives wakes, locks, and monitors; a parallel machine is safer
  than threading triage through every status consumer.
- Labels or a tag for staging. Rejected: labels lack transitions,
  snooze dates, duplicate links, and auditability.
- Direct-to-issue ingestion with agent triage afterwards (status quo
  extended). Rejected: live issues wake agents and spend budget before
  anyone agrees the work matters.
- Doing nothing. Rejected: the roadmap names Work Queues and
  ticket-system on-ramps explicitly, and receivers (#10273) need a
  governed landing zone.
