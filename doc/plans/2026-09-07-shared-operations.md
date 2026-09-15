# Shared operations plugin

## Purpose and boundaries

Paperclip already owns companies, tasks, approvals, workspaces, run history and
agent instructions. Add an optional plugin for explicit decision limits, durable
evidence with bounded handoffs, and controlled improvement of central policies.
Reuse those host capabilities. Do not replace the scheduler, native authentication,
or the LLM Wiki. Keep private account and project configuration outside this repo.

Success means executable and tested plugin controls, inspectable central
configuration, a verified local installation, and a reviewable community
contribution. Account setup remains instance-specific. A policy document alone
is not an enforcement boundary.
Authentication and provider quotas remain provider-owned. Unknown identity or
capacity cannot be represented as verified. A hash proves content identity, not
truth or whether a model followed instructions.

## Design

- `src/domain.ts`: pure, validated commands over company state. Immutable policy
  versions, explicit memory provenance and status, bounded context snapshots,
  receiver receipts, finite decisions, held-out evaluation records and rollback.
- `src/store.ts`: one company row in a plugin-owned database namespace. Conditional
  updates on the expected revision reject concurrent or stale writes. No SDK state
  read/modify/write sequence is advertised as atomic. Audit events persist with
  the state transition.
- `src/worker.ts`: host-authenticated APIs. Actor identity comes from the host,
  never a client-supplied role. Board-only activation and evaluation attestation.
  The UI uses the SDK bridge. Company scope applies to every database query.
- `src/ui/index.tsx`: inspect and operate policies, memory, decisions and
  improvement candidates; show errors, pending checks and explicit stop outcomes.
- Existing LLM Wiki supplies source ingestion and navigable knowledge. Explicit
  evidence records supply the small, versioned working set needed by a handoff.
- Private instance tooling binds separate native account profiles and projects,
  projects central policies into agent instructions, and verifies the installed
  result. Native desktop integrations are not claimed when no working transport
  or account authentication has been verified.

Decision matrix: a named owner decides reversible internal work after bounded
consultation; an operator decides spend, publication, account changes and
irreversible actions. Exhausted consultation produces a decision or escalation.
Reopening requires a changed requirement or different material evidence.
No majority vote or self-reported confidence can override authority.

Improvement loop: propose a version against an active baseline; freeze the
evaluation specification; collect independently attributed results within a fixed
trial budget; require all mandatory checks and non-regressions; activate only
against the same baseline; retain the previous version for rollback. This is
controlled policy improvement, not proof of general recursive intelligence.

## Tasks and checks

- [x] Install an isolated, loopback-only source runtime and persistent database.
  Verify API, UI asset, backup and restart recovery.
- [x] Build the validated domain engine and negative fixtures. Reject late debate,
  stale handoffs, self-evaluation, skipped gates and stale baseline promotion.
- [x] Implement company-scoped compare-and-swap persistence and authenticated
  plugin routes. Verify competing writes and cross-company reads.
- [x] Add the central operations page and package build. Verify errors and forms
  through the actual local plugin host.
- [x] Configure a private local company and canonical instructions; install the
  existing Wiki. Keep native account verification separate from plugin claims.
- [x] Exercise a synthetic handoff, decision and improvement/rollback workflow.
  Record unavailable authentication or desktop transports explicitly.
- [ ] Perform independent review, fix findings, run targeted tests and required
  repository checks; report any environmental failures without claiming success.
- [ ] Search related public work and submit a focused plugin PR with evidence,
  limitations and the repository's full PR template. Do not publish private data.

## Verification so far

The package has 56 passing focused tests across the domain, store and worker.
The host database prerequisite has 53 passing tests, including real PostgreSQL
checks of the complete task token and conditional write. Independent review
found and corrected SQL masking defects and a same-task UI refresh defect.
Desktop and 390-pixel browser checks exercised policy publication, visible
validation errors, memory persistence, refreshed task heads and snapshot creation.

Recursive typecheck and build passed with the final changes, excluding a separate
unfinished local plugin outside this contribution. The broad test run passed
6,028 tests with nine failures
and 14 skips. A targeted rerun after installing missing private test tools passed
15 tests; three unchanged Cursor remote fixtures remain blocked by their fixed
PATH excluding the private Node installation. These results are not a green
repository suite. CI and maintainer scope agreement remain open.

## Ownership and verification record

Domain worker owns `src/domain.ts` and its tests. Root owns SDK integration,
storage, packaging and documentation. UI can be delegated independently after the
domain command contract is available. Runtime/account work is private and cannot
be staged in this PR. Parallel ownership is disjoint; no worker reverts another's
edits. Review follows implementation; elapsed time and exit codes alone do not
establish a successful installation or useful improvement.
