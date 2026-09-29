# Correct Codex startup trust, history reads, and resume notices

Date: 2026-09-09. Approved scope: three Codex integration fixes. This supersedes
this document's earlier exploratory recommendations. Feed display and
full-answer streaming are separate preceding changes.

## Product rules

1. Trust the execution root that Paperclip selects at startup. Resolve it on
   the execution host, including a Git worktree's main repository trust key.
   Write only the isolated Codex configuration. Keep sandbox, tool, and secret
   controls authoritative. Later directory changes do not grant new trust.
2. Codex retains model conversation context. Paperclip reads provider state to
   establish execution authority or recover specific evidence. Normal resume
   must not download historical message contents.
3. A resume usage snapshot describes completed work. It can establish a
   cumulative baseline, but must not charge that work to a new run or produce
   a warning. Other stale notifications and invalid authoritative events keep
   their existing validation.

## Implementation

### Resume usage

Handle the exact root-thread `thread/tokenUsage/updated` snapshot before the
settled-turn warning branch. Keep its reported historical turn identity and a
bounded local `codex_resume_usage_snapshot` diagnostic. The Rust normalizer
must not emit a billable usage event for the snapshot. The TypeScript driver
persists its cumulative baseline with the existing checkpoint and reports a
monotonic run delta. Attachment begins a new delta at the last observed total;
recovery of the same run preserves its baseline. Repeated snapshots are not
additional receipts. Missing thread or turn identity does not gain authority.

### Supported state and history reads

Use `excludeTurns: true` for resume and `includeTurns: false` for thread state.
Request turn metadata with `thread/turns/list` and `itemsView: notLoaded`.
Only request `thread/items/list` content for a specific turn when reconciliation
needs its final answer, tool result, or completion evidence. Follow cursors,
keep stable order, deduplicate IDs, reject repeated cursors and incomplete
responses. A missing API reports a compatibility/read error; there is no
Codex full-history fallback.

Rust uses lightweight idle/active state, then paginated metadata when it needs
an active turn identity. The controller's runner transport serves targeted
recovery evidence from committed runner events; it rejects content reads
outside the retained turn window. Existing non-Codex proxy behavior stays
separate from Codex's protocol requirements.

### Startup trust

Before spawning Codex, canonicalize the selected root and add its trusted
project entry to the isolated config. Preserve unrelated settings and use a
private atomic replacement. Start the provider process in that same root,
so startup cannot load the Paperclip server checkout by accident. Persist the
startup directory in the existing optional session checkpoint for cold resume.
Remote roots are resolved on the execution host.

Retain the server-selected permission profile on subsequent TypeScript turns,
including Daytona's existing external sandbox profile. Do not change approval
policy or bypass the external sandbox boundary.

Repository trust loads hook definitions, but Codex 0.153.4 separately reviews
individual hook hashes. Preserve that policy. Acceptance explicitly approves
only the harmless fixture hook through Codex's supported config API; product
code does not bypass hook trust or invoke provider hooks itself.

## Verification and exclusions

Use Codex CLI 0.153.4, the pinned supported baseline. Test snapshot replay and
cold recovery accounting, cross-thread isolation, full-history avoidance,
metadata/item pagination, incomplete evidence, worktree/non-Git/canonical
trust, malformed config, and unchanged sandbox profiles. Run focused Rust,
TypeScript, server lifecycle/accounting tests, then repository typecheck,
tests, and build.

Use fresh local test-drive data and a disposable Daytona sandbox with real
Codex. Verify an initial repository read, two follow-ups, cold resume, config
and skill markers, one hook execution per startup/resume, exact cumulative
usage arithmetic, and absence of the three original warnings. Inspect the
browser answer after refresh. Record local/native and remote/TypeScript
proof separately, including any environment warnings or unverified behavior.

No new UI, task state, public API, database migration, retry policy, or session
replacement workflow. Preserve the Gmail handoff patch and existing test data.

See [acceptance evidence](2026-09-09-codex-integration-acceptance.md).
