# Live connector acceptance

Use after offline authoring, only for a separately authorized test. Test one
bounded workflow in an isolated instance and a disposable provider resource.
Do not interpret a request to author a definition as permission to run writes.

## Preflight

- Record source commit, dirty changes, instance URL, process workspace, isolated
  database, provider endpoint, connection, agent, and required tools.
- Establish the network path: hosted HTTP, same-machine desktop HTTP, or a
  supported local process. A laptop's loopback endpoint is not reachable as
  loopback from a cloud runtime. Never weaken shared egress rules to pass a test.
- Check provider prerequisites such as a running desktop app and open document.
  Capture the effective tool inventory and permissions for the actual test agent;
  a catalog card or connected badge does not prove either.
- Review instances may suppress execution. Inspect the current worktree run
  guard (historically `enableWorktreeRunExecution`) before diagnosing a queued
  task as a provider failure. Enabling it is a separate, isolated-instance
  action; keep unrelated agent schedules off and record any change for restoration.
- Use existing narrowly authorized permissions. Ask the operator for missing
  grants; do not broaden global defaults or downgrade provider risk annotations.

## Prove the actual path

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| Generator, schema and unit tests | Definition fits tested contracts | Provider connectivity |
| Board Test call | That test endpoint can execute the action | Agent discovery or execution |
| Fresh agent run with matching gateway audit | Agent used the managed connector | Correct final output |
| Readback and provider-side inspection | Expected result exists and is usable | Untested lifecycle or providers |

Start a real, bounded agent task. Do not manufacture heartbeat rows or count a
synthetic session as agent execution. Record terminal run state and correlate
connection/tool invocation events with that exact run ID.

A direct provider plugin, raw API call, browser action, or unrelated MCP server
can help diagnosis but cannot count as managed-connector acceptance. Inspect
actual tool namespaces and gateway events, not just the assistant's claim.
If an alternate plugin contaminates the test, exclude that run. With appropriate
authorization, isolate it in the test profile, retry a fresh session, and restore
the profile afterward. Do not disable the user's global plugins.

## Verify the result, not just success responses

For an authorized write, use an explicitly identified disposable resource. Save
the returned resource ID and pass it to subsequent calls rather than relying on
the active document. Read back expected content and counts. For visual output,
inspect a rendered screenshot for actual content, missing assets and layout.

A successful screenshot call can precede rendering. Use a bounded read-only
wait/recheck; a blank image is not acceptance. Stop after the test's declared
timeout and report the gap. Before retrying any timed-out write, reconcile IDs
and provider state to avoid duplicates. A local checkpoint is not an atomic
transaction with the provider. Never delete existing user content as cleanup.

## Diagnose and test failures proportionally

Distinguish missing tool discovery, denied permission, provider error, transport
timeout, and artifact-upload failure. A different profile ID alone does not
establish stale configuration. Preserve the error and trace for the failed run;
a later success does not prove its historical root cause.

Exercise applicable negative/lifecycle cases in the authorized sandbox:
unknown tool, denied action, missing desktop/document, disconnect/reconnect,
and OAuth refresh/revocation where supported. Mark inapplicable cases with a
reason and untested cases as pending. Security-policy or shared-runtime changes
need their own review; a local happy path does not clear those gates.

## Paper Desktop example: lessons from a local test

The September 2026 test used a same-machine HTTP MCP endpoint and an explicit
new file. The board harness imported three images; a separate real agent run
performed a bounded canvas write, readback and screenshot through the managed
gateway. Keep those two proofs separate. An earlier run through the direct
Paper plugin was excluded. An initially blank screenshot needed a later read.

For a new Paper test, recheck the official MCP docs and current tool schemas.
Confirm desktop state, explicit file targeting, and that the provider process
can read imported assets. Do not copy personal paths or file IDs. These findings
do not certify cloud execution, other providers, or OAuth lifecycle behavior.

## Acceptance receipt

Report these fields with secret-free evidence links:

- Source commit and local changes; runtime/provider versions where available.
- Instance, runtime placement and isolation boundary.
- Approved workflow, resource scope and effective permissions.
- Static checks, board calls, real run ID and correlated gateway invocations.
- Expected versus observed readback; rendered evidence when relevant.
- Negative/lifecycle checks: passed, failed, pending or not applicable.
- Temporary configuration changes and restoration result.
- Remaining release/security gates and what was not tested.

Provide a reproducible test with configurable IDs and documented prerequisites,
not personal credentials or dependence on an undisclosed private corpus. Claim
only the workflow and environment actually tested. Keep local acceptance,
PR-ready, merged and deployed as separate states.
