---
name: honeycomb-tracing
description: >-
  Trace Paperclip runs, requests, and full CI suites in Honeycomb. Use to find
  traces, diagnose latency, design readable and foldable waterfalls, configure
  opt-in OpenTelemetry, or add missing spans.
---

# Honeycomb Tracing

Produce an inspectable waterfall tied to the actual run or CI attempt, explain
which intervals dominate elapsed time, and identify the smallest useful next
experiment. Respect diagnosis-only requests; tracing does not itself authorize
replaying tasks, changing credentials, or deploying instrumentation.

## Choose the data path

| Question | Start here |
| --- | --- |
| Why is a task slow before, during, or after model execution? | Application workflow below; [runtime setup](references/runtime.md) if spans are absent |
| Why does an issue page load slowly? | Request spans plus browser timing, described below |
| Which CI jobs or test files delay the whole suite? | [CI profiling](references/ci.md) |
| How should a trace be organized so a person can understand it? | Human-readable waterfall guidance below and [trace design](references/trace-design.md) |
| Where should a new span go? | Instrumentation guidance below and [Observability contract](../../../doc/observability.md) |

Repository-relative paths and commands assume the checkout root. The maintained
contracts are `doc/observability.md` and `doc/ci-profiling.md`; recheck them and
the owning code when a deployed version differs.

Keep the repository's three paths distinct:

- **Observability:** operator-configured OpenTelemetry export to Honeycomb or
  another OTLP destination. With no endpoint, this tracing stays off.
- **Telemetry:** first-party events under `packages/shared/src/telemetry/`, sent
  to Paperclip by default unless opted out. Adding these requires the generated
  contract, Telemetry README, and privacy-review workflow in `AGENTS.md`.
- **Run log:** local `heartbeat_run_events` and measured performance events.
  Useful for correlation, but a local event is not proof of Honeycomb export.

Observability changes within the closed span-attribute allowlist do not need the
Telemetry privacy review. Preserve the endpoint gate and no-operation behavior.

## Find the application's trace

1. Resolve the instance, company, issue, agent, **run UUID**, and UTC interval.
   Record the effective harness/model, workspace/repository, warm or fresh session,
   and actual deployed revision. A task identifier is not a run UUID; one task
   can have several runs, and one run can have several execution attempts.
2. Prefer existing Honeycomb tools when exposed and authorized. Otherwise use
   the signed-in browser. The current project link targets team `paperclip`,
   environment `test`, dataset `paperclip`, and `service.name = paperclip`.
   These are defaults in `ui/src/lib/honeycomb-run-link.ts`, not proof of every
   deployment's destination. Verify the target before comparing data.
3. Open **View in Honeycomb** on the run page when available. It requires
   Paperclip Developer Mode and local implicit board or instance-admin access.
   This link queries existing data. **Re-run with provider trace** is a different
   action: it starts work and is not needed to read Honeycomb.
4. Without the link, calculate the same correlation value locally:

   ```sh
   # Set RUN_ID to the exact saved run UUID first; no trailing newline is hashed.
   node -e 'console.log(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 12))' "$RUN_ID"
   ```

   Filter `paperclip.task.run.run_id` to that 12-character lowercase hash and
   `service.name` to the observed service. Start with the run's absolute time
   window. The product link defaults to the last seven days; widen it for older
   runs. Group `COUNT` by `trace.trace_id` to discover matching traces.
5. The product's root filter is `name in [task.execution_attempt,
   task.provider_session, task.run]`. Use Honeycomb's `in` operator, not an
   invented OR group. Remove the name filter when setup failed or preparation
   spans are missing; older/standalone preparation can have a separate trace ID.
6. Open each relevant trace and its span details. A count-only query/export
   cannot establish span durations, parentage, or causal attribution. Capture
   the trace URL, time window, service/version, and relevant span names/timings.

In recent investigations, `HONEYCOMB_TEST_CONFIG_API_KEY` in the operator's
`~/.secrets` could read metadata but could not query traces. Ingest permission,
metadata access, and query access are different. Verify current capabilities;
when queries are unavailable, use the signed-in UI rather than creating a new
key or upgrading permissions. Read only needed secret fields, never dump the
file, and keep values out of commands, artifacts, repository files, and reports.

## Read the timeline correctly

| Interval | Meaning / next inspection |
| --- | --- |
| Run creation → executor start | Admission/queue delay; check drain, capacity, and dispatch evidence |
| `task.execution_attempt` | Server executor invocation through preparation, dispatch, durable reply, and cleanup |
| `heartbeat.prepare.*`, `native.controller.*` | Controller preparation; expand workspace, configuration, backend, and runtime-selection work |
| `task.provider_session` | Native provider lifecycle; includes preparation and execution, ends before outer workspace persistence |
| `task.run` | Legacy adapter root |
| `runner.session.startup`, `environment.*`, `stage.*`, `sandbox.*` | Runner/environment acquisition, workspace transfer, and startup |
| `agent.turn` | Agent turn time; inspect actual children before calling all of it model latency |
| `execution.workspace_finalize`, `workspace_sync.*`, `completion.*`, `response.*` | Copyback, settlement, response persistence, and publication work |

The attempt and provider lifecycle are linked roots; they need not share a trace
ID. Neither is a guarantee of one continuous trace across queueing or restarts.
Correlate with the run log and saved reply timestamps. The native local event
`task.run.measured` includes terminal elapsed time and durable copyback.

Use start/end times to compare serial intervals and the union of parallel work.
Never add a parent to its children or sum parallel branches as elapsed time.
For example, `configuration_skills` is inside `execution_configuration`, and
`skills.prepare` overlaps the broader `heartbeat.prepare_before_environment`.
Detail spans are capped at 16 per name per attempt; missing per-item children
do not mean later items did no work.

Distinguish first streamed text, committed reply, externally delivered message,
and browser paint. A successful `response.transaction.commit` proves durable storage;
`response.publish` is enqueueing and `execution.realtime` is server dispatch.
Neither proves that the user saw the response. Choose the boundary the user asked
to improve, then measure the whole path to that boundary.

For slow issue pages, combine `issue.read.<phase>` with `Server-Timing`
(`paperclip_issue`, `issue_<phase>`) and the browser's request waterfall and
`issue-detail:navigate→content-paint` measure. Concurrent reads overlap. Fast
API completion does not establish fast conversation reveal or rendering.

A long parent span without children is an attribution gap. It does not prove
SQL, network, or model time. For database hypotheses, use
[fix-slow-queries](../fix-slow-queries/SKILL.md). For CPU hypotheses, use a bounded
authorized profile covering the actual slow phase; a sample taken while queued
cannot explain preparation. Low aggregate container CPU does not exclude a
blocked Node main thread. Keep profiled diagnostics separate from unprofiled
acceptance timings.

## Design a human-readable waterfall

A collapsed trace should tell a person what the system is doing; expanding a
phase should explain where its time went. Before adding or reorganizing spans,
sketch the meaningful phases and compare them with the existing exported tree.
For application runs, make preparation, runner startup, agent work, and settlement
easy to distinguish. For CI, retain workflow/job/step/file/test ownership.

- Group by purpose: file staging belongs under `stage.sync`, with workspace and
  asset branches such as `stage.asset.home`; provider operations belong beneath
  the work that caused them. Reuse the owning path's existing semantic groups.
- Use real OpenTelemetry parent contexts. A dotted name or a `parentName`
  attribute alone does not make a foldable hierarchy. A flat trace can need
  better parentage even when it already has enough measurements.
- Preserve useful detail beneath the groups. Improve folding before deleting
  spans; account for any measurement moved to an attribute, event, or run log.
- Make the hierarchy truthful on failure and during concurrent work. Cleanup
  belongs to settlement even when startup fails; long-lived processes need an
  owner that covers their lifetime. Preserve documented links between separate
  attempts and provider lifecycles rather than forcing everything into one root.

Read [trace design](references/trace-design.md) when designing or reviewing a
hierarchy. It includes a staging example, lifecycle pitfalls, and acceptance
checks for the actual exported waterfall. The current Observability contract
owns exact span names and boundaries; historical examples are not a new schema.

## Add only the missing instrumentation

Read applicable repository rules before editing. Reuse the existing timing seams:

- `server/src/services/execution-preparation-timing.ts`:
  `withRunExecutionTiming`, `createRunPreparationTiming`, `measureRunPhase`, and
  `beginRunPhase`. Use the existing attempt; do not create a new root per detail.
- `server/src/services/native-runtime/native-run-trace.ts`: native lifecycle
  hierarchy and links to the owning attempt.
- `server/src/services/issue-read-timing.ts`: issue-read phases and Server-Timing.
- `packages/adapter-utils/src/acpx-engine/startup-timing.ts`: runtime parent
  context and closed span attributes. Adapter utilities receive the host context
  rather than constructing an independent exporter.

Extend the closed phase union when a meaningful boundary is missing. Wrap the
actual awaited operation, preserve parent context across async/provider boundaries,
and end spans on success and failure. Keep real wall times for spans recorded
after the operation. Use existing hashed IDs, closed enums, and allowed numeric
counts; do not add prompts, tool arguments/results, paths, raw identifiers,
credentials, or exception text. Do not enable all filesystem instrumentation to
explain one slow scan.

Observability must not retry the operation, replace its return/error, change
authorization/locks, or break execution when the tracer fails. Preserve root
sampling and the explicit endpoint gate even if another library registers an
OTel provider. Update `doc/observability.md` when the trace contract changes.
Run focused tests for endpoint-off behavior, parentage/concurrent-run isolation,
failure handling, and the changed seam. Use real exported evidence to claim that
new spans appear in Honeycomb; a unit-test tracer alone does not prove ingestion.
For hierarchy changes, also inspect collapsed and expanded exported views using
the [trace-design acceptance checks](references/trace-design.md#verify-the-exported-waterfall).

## Compare and hand back useful evidence

Choose the largest actionable serial wait or unexplained gap, then reproduce it
at the smallest faithful layer. Compare matched runs: same harness/model,
workspace size, session warmth, concurrency, and relevant revision/configuration.
Report sample count and median/range when several runs are available. Preserve
failures; a failed fast run is not a latency improvement.

Return the run/attempt and trace links, observed revision, end-to-end timing,
dominant non-overlapping phases, uncertainty, and next action or verified gain.
Label local, synthetic, and hosted evidence precisely: a dev-host reproduction
is not a local checkout run, and a merged fix does not prove hosted improvement.
If traces are unavailable, state the missing access or coverage and what the
run log/browser measurements actually establish.
