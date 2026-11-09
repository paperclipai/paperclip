# Exact warm-owner proof across native configuration changes

A follow-up can fail with `prior_owner_terminal_state_indeterminate` before
provider execution even when its prior heartbeat succeeded. The old predicate
required the next configuration digest to match before recognizing the idle
owner; this prevented the existing compatibility step from retiring a process
whose configuration changed.

Keep the session cache, durable-root admission and compatibility retirement in
their current coordinator. They share process and instruction-copy ownership;
this fix does not move their lifetime or weaken their gates. Cache each actual
owner's heartbeat run ID and require it to match the durable prior-run identity.
Keep company/session/workspace/environment checks and the terminal database
check. Let the later compatibility step decide reuse versus retirement, and
continue to reject unconfirmed retirement before another provider executes.

Verification is through the production session entry point with scripted native
backends and durable local owner files. The six existing selected controls pass.
The initial three-case reproduction has one pass and two failures at the same
prior-owner guard; after the fix all three pass. Eight focused controls now cover
unchanged reuse through three turns, changed settings, changed runtime context,
failed retirement, stale recorded identity, active owner, missing owner and a
different environment. The runtime-context case uses the current v5 input and
fails on the baseline at the same prior-owner guard before passing the repair. Replacing the exact
run-ID comparison with an any-owner check makes the stale-owner control fail;
the source is restored afterward.

The first complete affected executor and resume suites passed 764 cases before
the additional v5 runtime-context case. Full typecheck initially found an
optional-argument error in the test database wrapper; after that correction,
full typecheck and build passed. The v5 fixture expansion then exposed a legacy
v1-only type on the shared database fixture. Its implementation only uses the
common binding, so it now accepts the full native input union. After integrating the separate idle-expiry admission repair from #16432, the
complete executor and resume suites passed 767 cases with zero selected skips.
Full repository typecheck and build passed on the same frozen code and tests. Scripted-provider results do not establish real Daytona recovery,
managed subscription behavior or hosted latency. Recheck the failed hosted
continuation after normal deployment, preserving its existing recovery evidence.
The broader response-latency target remains open independently of this repair.
