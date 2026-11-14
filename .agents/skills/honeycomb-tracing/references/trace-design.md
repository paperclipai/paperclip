# Human-readable trace design

Read this when adding, reorganizing, or reviewing a waterfall's hierarchy.
The goal is to understand the work at a glance, then expand the slow phase to
find its cause. Follow the current
[Observability contract](../../../../doc/observability.md) for exact names,
roots, lifecycle boundaries, sampling, and allowed attributes.

## Organize by the work being done

Sketch a few meaningful phase groups before choosing detailed spans. Each fold
should answer a useful question: preparing what, connecting to what, executing
what, or persisting what? Prefer recognizable operations over a mirror of the
source-file or helper-function hierarchy. More nesting is useful only when it
adds meaning; do not target a fixed number of root children or depth levels.

For example, sandbox staging has a natural structure:

```text
stage.sync
├── stage.workspace
│   ├── pack
│   └── sandbox.daytona.transfer
└── stage.asset.home
    └── sandbox.daytona.transfer
```

This is an illustrative subtree, not a complete native-run schema. Both transfer
spans keep the same operation name; their actual parents explain their purpose.
Keep runner artifact preparation, sandbox acquisition, file syncing, daemon
startup, preview resolution, WebSocket activation, agent work, and settlement
under the closest meaningful phase that actually owns them. Retain useful leaf
timings when they explain distinct waits or operations.

Use stable operation names and the existing bounded attributes for dimensions.
Do not put raw IDs, paths, commands, or attempt numbers into new span names.
Avoid duplicate full-duration wrappers that add no distinct meaning. If a
measurement is redundant, state where its information remains available before
removing it. An instantaneous milestone can be an allowed event on its semantic
parent; it need not become another zero-duration lane. Preserve existing event
and attribute contracts when changing representation.

## Make parentage match execution

- Open lifecycle parents when work begins, before their children are emitted.
  End them after the work they own has settled. For delayed span recording,
  retain the real operation timestamps and captured parent context; do not move
  timings to make the drawing look tidy.
- Carry actual span context through awaited operations and asynchronous
  callbacks using the existing trusted runtime/provider seams. A name-based
  parent hint cannot distinguish repeated or concurrent operations. Never use
  a process-global current parent that lets one run adopt another run's spans.
- Capture the owning run and phase when dispatching deferred work. Warm-session
  reuse must not attach new tools or callbacks to a previous turn. Use the
  documented fallback when no matching live scope remains.
- Exercise error and cancellation exits. If startup fails, open the appropriate
  cleanup/settlement scope before checkpoint persistence or teardown. Those
  operations must not inherit the last startup scope merely because the normal
  terminal event never arrived.
- Give a long-lived daemon or streamed process an owner that covers its actual
  lifetime. A process launched during startup may overlap the agent turn; its
  launch step is not necessarily its lifetime parent. Keep real overlap visible.
- Preserve the current distinction between server execution attempts, native
  provider lifecycles, and trigger requests. Linked roots can be intentional
  because of queueing, retries, process lifetimes, or root sampling. Do not adopt
  an HTTP request as the run parent by accident, backdate a later parent to cover
  historical work, or restore the old single-`task.run` design from a session.

## Verify the exported waterfall

For an instrumentation change, use representative real operations within the
authorized scope and open their actual Honeycomb traces. Include success and
the relevant failure/cleanup path; cover warm resume, concurrency, or retry when
the changed ownership crosses those boundaries. This is not a requirement to
run every harness and deployment for every span edit. If live evidence is
unavailable, report that gap and the narrower evidence collected.

Inspect both views:

- **Collapsed:** the phases explain what happened and where elapsed time went
  without reading dozens of sibling leaves. Separate linked traces are identified
  and correlated; unexplained gaps remain visible.
- **Expanded:** a slow phase leads to useful operations. Check actual parent IDs,
  representative cross-process children, repeated/concurrent operations, error
  status, and start/end times. Cleanup belongs to the right phase. Investigate
  missing parents or children outside an owner's lifetime, including clock
  skew, before treating the tree as correct.

Compare the baseline and changed trace's phase grouping, root children, depth,
and retained measurements. These are diagnostic clues, not numeric targets.
Do not add parent and child durations or sum overlapping work. Do not relabel an
unattributed parent interval as database, network, or model time without evidence.

Return the run/attempt, deployed revision, trace links, what now folds correctly,
and any remaining attribution gaps. Report export/structure quality separately
from task outcome: a failed task can yield a useful trace, but successful export
does not make that task successful. Focused tests establish local contracts;
only inspected exported evidence supports a claim about the Honeycomb waterfall.

## What the August 26 session taught us

The user's request was to retain the valuable detail while improving semantic
steps, parentage, logical grouping, and folding. The old native trace already
had many measurements; attaching them all to its root made it hard to read.

The implementation hand-off reported 75 focused tests passing and said the next
run should produce the new waterfall. The user then had to request real runs.
Those runs revealed an unintended HTTP parent and failure-time checkpoint
persistence under startup. Export succeeded even though the Daytona task failed.
Carry forward the design preferences and the need to inspect real failure
parentage. The session's schema version, root name, counts, and particular task
failure are historical details, not permanent requirements.
