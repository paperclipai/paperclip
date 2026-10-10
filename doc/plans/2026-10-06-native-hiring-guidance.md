# Native hiring guidance — bounded qualification

## Outcome and finish line

Reduce native hiring guidance without worse hiring/reuse outcomes. Prepare one
reviewed PR with source checks, complete instruction measurement, and a matched
Codex/Claude/OpenCode Product E2E comparison. No merge is authorized.

## Scope

Base: `b508a05c43054ca9cfc54926eaa2af4a825e48dc` (includes #15372).
Branch: `codex/native-hiring-guidance`.
Remove only the obsolete fixed recipe that mandates `search_api`/`call_api` for
hiring. The existing available `hire_agent` tool already describes persistent
teammates, runtime inheritance and reuse through `list_agents`. Keep its schema,
authority and the generic API fallback unchanged. Preserve the helper-thread
boundary, all assigned-worker, dependency, connection and completion guidance.
Advance the fixed prompt revision to v6; verify old v5 checkpoints rotate while
same-context checkpoints remain reusable, including tool-refresh paths.

## Measurement and comparisons

Use the existing production full-tool-catalog measurement for all three native
transports at start, resume and continuation, plus the actual OpenCode MCP
catalog. Count serialized UTF-8 bytes and normalized projections, not billed
tokens or private vendor prompts. Baseline captured before edits at exact base.

Select only `everyday-workflows.<profile>.local.hire-reuse` for `runner-codex`,
`runner-acpx-claude`, and `runner-opencode`. Six cells total across candidate and
baseline; one attempt each, existing 720000 ms cell deadlines, 12-run bounds and
1000-cent company/lead hard stops. No completed-source behavioral rerolls.
Freeze sources, fixtures, controls and trusted workflow revision before dispatch.
Paid runs have the human's standing authorization. Original grades, partial
attempts, all actual runs, unknown charges and cleanup receipts stay preserved.

The unchanged oracle requires one managed native teammate with the correct
manager/binding, actual child execution, reuse of that same identity, and both
usable deliveries. Inspect final parent artifact identity and tool selection
separately; passing aggregate grades alone do not establish these properties.
Earlier failed relocation and OpenCode cohorts remain historical failures.

## Local admission

The reduction is 123 UTF-8 bytes (23 words) in the fixed prompt. No text moves
into tool descriptions. Across all nine provider/phase projections, normalized
start/resume size changes from 53,341 to 53,218 bytes; continuation changes from
50,949 to 50,826 bytes. All 41 tool definitions and input projections remain
identical after workspace-path normalization. This is about 0.23% of the
start projection, not a token, bill, latency or vendor-prompt claim.

The four focused files pass 1,929 distinct tests, including old-prompt rotation
and valid current-context resume. Product E2E admission passes 1,404 TypeScript
and 128 Node tests. Full repository typecheck and build pass. Product E2E
typecheck passes after refreshing stale built dependencies. The full repository
test run is pending. Repeat only the six credential-free measurement tests after
the candidate commit to attach a clean immutable source receipt.

The first local test attempt exposed an incorrect new test control: it requested
a tool refresh from a provider marked as unable to refresh. The corrected control
uses the same capability flag. This did not change production behavior.

## State

- [x] Inspect current production contracts and capture clean baseline measurement.
- [x] Implement prompt-only hiring recipe removal and checkpoint boundary coverage.
- [x] Relevant tests, source-scope audit and candidate measurement (precommit).
- [ ] Freeze matched source refs and complete six bounded original live cells.
- [ ] Inspect grades, artifacts, source controls, usage and cleanup.
- [ ] Full checks, reviewed PR, truthful public summary and final readiness.
