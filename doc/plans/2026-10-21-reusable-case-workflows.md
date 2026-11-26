# Minimal reusable workflows

Implement the approved name-and-prompt workflow model on branch
`codex/reusable-case-workflows`, under `experimental.enableCases`.
Workflow definitions own reusable text; cases retain one primary task and use
its revisioned `workflow` document. Handoffs own explicit adoption/refresh/detach,
captured prompts, and transition history. No interpreter or new execution service.

Acceptance: reuse across cases; same-task A → B → A; shared edits do not change
case copies; retries/restarts do not duplicate revisions; cancelled pending
adoptions and document conflicts preserve instructions; old inline cases,
authorization, and flag behavior remain compatible. Verify through real database,
native tools, existing case UI, and a bounded configured-provider journey.

Endpoint: one reviewable PR with required checks. No merge or deployment requested.
Deferred: workflow authoring UI, deletion/archive, import/export, role binding,
graph validation, and Spec Kit integration.

Status: implementation and live acceptance complete. Full-suite verification and
review are tracked in https://github.com/paperclipai/paperclip/pull/17114.

Implementation: schema/migration, definition REST service and optional native
tools, transactional adoption with private prompt snapshots, bounded reads,
case context, Work/history/Audit presentation, contracts, docs and maps are in
place. The arithmetic Product E2E journey now measures A → B → A and observed
workflow-document reads; inline receipt coverage remains.

Verification so far: real-database handoff tests, authenticated native-tool/API
contract tests, 37 case/Audit UI tests, and arithmetic oracle calibration pass.
Repository-wide typecheck and build pass, including after a clean rebase onto
master. Full-suite results are tracked in the PR.
Token gates, migration checks, module boundaries and map structure checks pass. Earlier failed attempts
were an incorrect assertion about conflict wording, missing fresh-worktree
build dependencies, outdated API-schema assertions and generated inventories;
these are retained in temporary logs and corrected before reruns.

Live evidence: the subscription attempt reached kickoff and browser readback,
then the first provider run failed with HTTP 429 (`responseTooManyFailedAttempts`).
That failure is retained separately. An explicitly authorized API-key attempt
uses the same arithmetic procedure, oracle and single-attempt run limits in a
fresh isolated campaign. Both arithmetic credential modes are now selectable.
The first API attempt completed four successful provider runs, A → B → A, and
normal terminal case completion. Its old four-handoff oracle kept waiting for
exactly four rows despite the valid fifth terminal row. The attempt was stopped
with normal launcher cleanup and remains failed. The fixture now explicitly
requires the terminal intent and its retained procedure revision; positive and
negative oracle tests pass. A fresh single-attempt campaign verifies that fix.
The terminal-aware API attempt passed all nine durable workflow checks and the
case Work/history browser assertions. Its final chat-marker assertion failed:
the existing presentation policy chooses the explicit terminal handoff comment
over the later completion summary. The fixture now puts the marker in that
authoritative visible comment and retains the earlier failure separately.

Runner contract checks exposed strict JSON-schema branches and an omitted
public semantic catalog registration for the four tools. Both are corrected;
all 144 affected catalog/discovery tests and 27 prompt/coverage tests pass.
Generated projections were refreshed from a fresh TypeScript build. The
repository-wide suite uses the repository-supported isolated shard groups.

Live acceptance passed in `reusable-workflows-api-final-2026-10-21`, using local
code matching commit `a1d73b4652`: four actual Codex API runs, all nine durable
checks, current Work summary, historical workflow/phase names, original task
completion and visible terminal comment. Cleanup passed. The result reports
token usage but incomplete aggregate dollar accounting; it does not establish
zero provider cost. Earlier campaigns remain failed and unchanged. The report
is retained at `tests/runner-e2e/results/reusable-workflows-api-final-2026-10-21/dashboard.html`
(ignored local evidence, not committed screenshots).

Final verification retains the interrupted default serial run as incomplete.
The replacement covers all 1,082 general server suites and 161 serialized suites
without gaps or overlap, plus all three workspace groups. CI caught a missing
workflow route-inventory registration; explicit route declarations and that
registration now pass the OpenAPI/native-tool integration checks (49 tests).
Case context selects only incoming-handoff metadata, avoiding reads of the
private captured workflow prompt on each resume.

The final context projection passes all 90 database handoff checks and server
typecheck. CI also detected the changed shared instruction source in Copilot's
pinned identity. Version 56 binds the new guidance, retains v55 decoding and
historical fixtures, and passes 142 installation/sidecar checks. This is static
compatibility evidence; live acceptance here covers native Codex. One local
environment-route socket disconnect remains recorded; its separate 11-test
rerun passed without changes to that unrelated route or test.

Review found that separate prompt pages could observe different definition edits.
Workflow reads now return a content fingerprint and require it on continuation
pages, rejecting edits with 409 before returning another page. The HTTP test
covers a same-length edit and restarting with a four-byte window; compression
preserves the fingerprint through its weak ETag prefix. No workflow version
entity or stored field is added. Final check and review results live on the PR.

The shared native execution prompt omits experimental Cases/workflow guidance,
including the Mermaid diagram recommendation. Runtime-context prompt text lives
in the CODEOWNERS-protected `runtime-context-prompts.ts` as exported strings;
composition and snapshot validation remain in `runtime-context.ts`. Current
prompt metadata advances to v7, while saved prompt snapshots remain readable.
Copilot v57 binds both source files and retains historical v56 decoding.
