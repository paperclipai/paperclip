---
type: Engineering Journal Entry
title: Phase 6 feature-flagged Paperclip adapter implementation
description: Implementation decisions and evidence for the default-off native runner seam, durable replay/finalization, and legacy kill switch.
tags: [native-runner, phase-6, implementation, paperclip, security, replay]
status: stable
generated: { by: openai/gpt-5.6, at: 2026-08-09T07:42:08Z }
entry_kind: phase
phase: "6"
---

# Context

The approved Phase 6 design permits one narrow Paperclip integration at the
runner's public port/session boundary. The implementation must preserve all
existing server authority and keep legacy execution as the default.

# Decisions

1. Persist runtime selection and its reason before provider execution. Explicit
   ineligible opt-ins fail; the disabled flag and absent opt-in select legacy.
2. Use the existing heartbeat event timeline with one row-locked per-run
   allocator for legacy, recovery, cancellation, and native writers.
3. Bind the production port to company, issue, run, agent, completion contract,
   runner source, and control-plane source identities. Acknowledgement follows
   commit; duplicate identity with different bytes is a conflict.
4. Construct Codex and its normalized session entirely inside the package.
   Paperclip supplies only the closed native input and persistence port.
5. Persist semantic result and terminal state before workspace finalization;
   apply issue status only after the workspace barrier succeeds.
6. Treat the model disposition as evidence. A pure server arbiter and
   status-version CAS own `done`, `blocked`, and non-terminal decisions.
7. Reuse the existing cancellation/budget/resource path with a native session
   handle; never fall back to legacy inside a selected native run.
8. Keep the feature default false. Recovery reads persisted run/coordinator
   state and therefore remains correct after the flag is disabled.
9. Persist provider session checkpoints and recover them fail-closed; a restart
   may reconcile missing control facts but may not open a second provider
   session for the same run.
10. Treat model citations as claims. Only server-verifiable durable records can
    satisfy completion criteria, and every non-terminal decision must create or
    bind a real review, wake, blocker, or recovery path in the status transaction.
11. Persist the closed native input before opening the provider. Result-less
    transport failures keep the same run live behind a bounded database lease;
    restart, flag disablement, and an already-active provider turn cannot create
    a second provider session, run, or turn.
12. Project supported resolved interaction responses through the existing
    authorized issue-interaction service. Governed, unresolved, unsupported,
    cross-boundary, or self-approved requests fail closed without credentials.
13. Remove fixture-scenario arbitration from production. Finalization consumes
    durable evidence facts, and attention, cancellation, reconciliation,
    compatibility, and migration consumers are invoked from their live server
    paths.
14. Handle every native status effect exhaustively. A delivered row is written
    only after its named target exists or changes; pending delivery verifies the
    original target, and unknown effects or target types roll back.
15. Prove at-most-once materialization by replaying each corpus decision and
    requiring one decision identity, one delivery attempt, and the persisted
    target state.
16. Treat direct resolver calls as pure policy/read-model evidence only.
    Operational corpus rows must enter through cancellation, attention,
    reconciliation, or runtime selection and retain that entrypoint receipt.
17. Resume workspace finalization through the workspace operation recorder and
    observe its actual result; never insert a pre-succeeded recovery marker.
18. Begin accepted attention routing at the immutable package-result boundary.
    The finalizer records a request-specific assessment, resolves delegates
    from eligible same-company agents, creates delegated work through the issue
    service, routes human authority through the interaction service, and
    records cross-company rejection through decision/recovery/audit owners.
19. Keep pending replay acknowledgement-only, scoped to its original decision,
    and fail when the owning transaction's target no longer exists.
20. Treat `experimental.enableNativeRunner` as the only kill switch. Persisted
    native runs retain native recovery after flag-off; fresh unresolved runs
    select legacy. Never rewrite the agent profile or persist a second rollback
    control.
21. Treat duplicate and stale attention as terminal audit-only finalization.
    The public port persists the result, the finalizer binds the exact durable
    interaction target and commits a null-decision coordinator, and replay
    short-circuits without another assessment or interaction mutation. Missing
    and cross-company targets remain named fail-closed recovery.

# Evidence

- [Phase 6 verification](../evidence/2026-08-09-phase-06-verification.md)
- [Phase 6 reference](../../docs/phase-06-thin-paperclip-adapter.md)
- [Runnable tutorial](../../docs/tutorials/phase-06-thin-paperclip-adapter.md)
- Package conformance and recovery: four files, seven tests passed.
- Phase 6 acceptance-matrix entry points: thirteen files, forty-six tests passed
  with zero skips, including the database-backed selected-task canary, six
  atomic-liveness failpoints, migration, sequencing, bounded recovery, and
  legacy compatibility.
- The migration rehearsal rewound to a production-shaped pre-0211 schema and
  applied the complete migration; the actual flag-off heartbeat executed the
  legacy adapter/finalizer and created zero native rows.
- Section 18.13 source corpus: 52 fixture-specific database executions passed
  through named production consumers. The duplicate/stale rows enter through
  the real finalizer owner rather than the persisted router directly. Consumer returns and persisted rows
  supplied all eleven assertions: run status, status/preserve action, reason,
  required/forbidden effects, live path, claim preservation, native-record
  behavior, decision count, maximum wake count, and maximum notification
  count. All 70 matrix rows require their named consumer execution and compare
  that consumer's semantics. Per-fixture mutation checks reject changes to
  every expected field; no test-owned policy table supplies observations.
- All native effect observations resolve to actual interaction, wake, issue,
  recovery, run, workspace-operation, contract, decision, or governance state.
  Unknown effects fail before any decision, ledger, status-version, or
  coordinator mutation.
- Negative entrypoint proofs remove cancellation auditing and the finalizer-
  owned attention ingress, change the global flag input, remove reconciliation/
  workspace execution, and delete the original pending-effect target. Every
  mapped fixture fails even though its pure resolver still returns the expected
  policy label.
- The production heartbeat reaper resumed one persisted result-less run through
  the original execution/finalization path with the flag disabled. It recovered
  an already-active scripted provider turn and produced exactly one result,
  assessment, decision/effect set, and terminal run without a new run, session,
  turn, or legacy call. The provider boundary remains scripted, not live Codex.
- Runner, shared, server, and database typechecks passed; migration safety
  passed.
- The remediation-7 rerun passed the 13-file/46-test zero-skip matrix, all 19
  runner-spec checks, runner docs validation, relevant TypeScript checks, and
  `git diff --check`. A final call-graph review confirmed the public port owns
  result persistence, the finalizer alone commits the zero-decision outcome,
  the internal router binds the exact same-company interaction, and committed
  replay short-circuits without another assessment or target mutation.
- The remediation-8 documentation reconciliation corrected the design's
  authoritative allowlist to 89 files and mechanically compared it with the
  Phase 6 branch diff with no missing or extra path, including the README,
  spec checker, canonical helper, runtime-mode test, and database-backed port
  test paths.

# Failures

- The generated migration initially failed the large-index safety check. The
  transactional uniqueness and nullable-source rationales are now recorded at
  each affected index, and clean migration replay passes.
- The first server compile exposed stale package build output and a runner
  source-identity mismatch. Building the package before server integration and
  passing the persisted runner instance into the package-owned Codex factory
  fixed the contract rather than weakening port validation.
- The historical event writer used `max(seq)+1` outside a shared transaction.
  All service writers now use the row-locked allocator; the one in-transaction
  scheduled-retry writer advances the same counter atomically.

# Known gaps

- Phase 6 supports local, standard, workspace-backed `codex_local` tasks only.
- It adds no browser UI or public runner WebSocket.
- Resolved confirmations and question answers are materialized only through the
  existing authorized Paperclip interaction service; governed and unsupported
  requests cannot auto-approve.
- Phase 6 adds no attention UI or public attention endpoint. The Codex v1 tool
  authors compact `kind`/`summary` requests; richer canonical PRP target hints
  are server-validated but do not yet have provider authoring UX. External
  execution, credential delegation, and auto-approval remain deferred.
- Live operator proof depends on a board-authorized local instance and an
  already authenticated Codex installation; deterministic CI uses the same
  public session contract with a scripted backend.
- The remediation did not dispatch a new live provider task or mutate rollout
  settings. The verified “internal canary” and post-kill-switch trace are the
  embedded-PostgreSQL scripted selected-task and actual flag-off legacy
  heartbeat cases; the live
  tutorial remains an explicit operator checkpoint.

# Follow-up questions

- Should Phase 7 expose a one-time outbound runner lease instead of the
  in-process production port?
- Which native finalization fields should receive a dedicated operator UI after
  the tracer rollout proves stable?
