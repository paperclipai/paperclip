import { createHash } from "node:crypto";

const millis = (value) => Date.parse(value);
const id = (value, size = 16) => createHash("sha256").update(value).digest("hex").slice(0, size);
// "error" is a commit status that could not complete.
const failed = (status) => ["failure", "failed", "error", "timed_out", "timedOut", "cancelled", "interrupted"].includes(status);
const text = (value) => typeof value === "string" && value.length <= 4096;

// Outside checks belong to the push that started this run. A check that began
// well before the run (for example, before a later label event) is not part of
// this run's elapsed time.
const checkSlackMs = 60_000;
const label = (value) => typeof value === "string" ? value.slice(0, 256) : "";

// Reduce GitHub's check-run, commit-status and workflow-run listings for the
// run's head commit to the allowlisted fields the trace needs.
export function normalizeChecks(run, { checkRuns = [], statuses = [], workflowRuns = [] } = {}) {
  const checks = [];
  for (const check of checkRuns) {
    // GitHub Actions check runs are jobs. This run's jobs are already spans,
    // and other workflows are summarized per workflow below.
    if (!check?.app?.slug || check.app.slug === "github-actions") continue;
    checks.push({
      kind: "external_check", app: label(check.app.slug), name: label(check.name),
      status: label(check.conclusion || check.status), startedAt: check.started_at,
      completedAt: check.status === "completed" ? check.completed_at : null,
    });
  }
  const contexts = new Map();
  for (const status of statuses) {
    if (typeof status?.context !== "string") continue;
    contexts.set(status.context, [...(contexts.get(status.context) || []), status]);
  }
  for (const [context, entries] of contexts) {
    entries.sort((a, b) => millis(a.created_at) - millis(b.created_at));
    const last = entries.at(-1);
    checks.push({
      kind: "external_check", app: "commit-status", name: label(context), status: label(last.state),
      startedAt: entries[0].created_at, completedAt: last.state === "pending" ? null : last.created_at,
    });
  }
  const workflows = new Map();
  for (const other of workflowRuns) {
    if (other?.id === run.id || other?.path === run.path || other?.head_sha !== run.head_sha
      || !["pull_request", "pull_request_target"].includes(other?.event)) continue;
    const known = workflows.get(other.path);
    if (!known || millis(other.created_at) > millis(known.created_at)) workflows.set(other.path, other);
  }
  for (const other of workflows.values()) {
    checks.push({
      kind: "workflow_check", app: "github-actions", name: label(other.name),
      status: label(other.conclusion || other.status),
      startedAt: other.run_attempt > 1 ? other.run_started_at : other.created_at,
      // GitHub exposes no completion time for a run; its last update is the closest record.
      completedAt: other.status === "completed" ? other.updated_at : null,
    });
  }
  return checks;
}

const runStart = (run) => millis(run.run_attempt === 1 ? run.created_at : run.run_started_at);
// A rerun repeats jobs, not the outside checks, so only a first attempt owns them.
const ownChecks = (run, checks) => run.run_attempt === 1
  ? checks.filter((check) => !(millis(check.startedAt) < runStart(run) - checkSlackMs)) : [];

export function pendingChecks(run, checks, kind = "external_check") {
  return ownChecks(run, checks).filter((check) => check.kind === kind && !check.completedAt);
}

export function buildTrace(run, jobs, records = [], { sampleRate = 1, checks = [], testDetail = true } = {}) {
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1) throw new Error("Invalid sample rate");
  if (run.status !== "completed" || !jobs.length || jobs.some((job) => job.status !== "completed")) {
    throw new Error("A complete workflow attempt and its full job inventory are required");
  }
  if (jobs.some((job) => job.run_id !== run.id || job.run_attempt !== run.run_attempt)) {
    throw new Error("Job inventory contains another run or attempt");
  }
  const key = `${run.repository.full_name}:${run.id}:${run.run_attempt}`;
  const traceId = id(key, 32);
  const rootId = id(`${key}:root`);
  const start = runStart(run);
  // The attempt jobs API can relabel carried-over successful jobs with the
  // new attempt number. Their completion clocks still precede this attempt.
  const carriedJobs = run.run_attempt > 1 ? jobs.filter((job) => millis(job.completed_at) < start) : [];
  jobs = jobs.filter((job) => !carriedJobs.includes(job));
  if (!jobs.length) throw new Error("No jobs executed in this workflow attempt");
  const end = Math.max(...jobs.map((job) => millis(job.completed_at)).filter(Number.isFinite));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Invalid run timing");
  const events = [];
  const warnings = [];
  if (carriedJobs.length) warnings.push(`${carriedJobs.length} completed jobs carried over from earlier attempts were excluded`);
  const shared = {
    "service.name": "paperclip-ci",
    "trace.trace_id": traceId,
    "ci.repository": run.repository.full_name,
    "ci.run_id": String(run.id),
    "ci.attempt": run.run_attempt,
    "ci.commit": run.head_sha,
    "ci.branch": run.head_branch,
    "ci.url": run.html_url,
  };
  const span = (spanId, parent, name, from, to, fields) => {
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return;
    events.push({
      // Sampling selects whole runs. Every span of a selected run is kept, and
      // this weight lets Honeycomb scale counts back to all runs.
      time: new Date(from).toISOString(), samplerate: sampleRate,
      data: { ...shared, "trace.span_id": spanId, ...(parent ? { "trace.parent_id": parent } : {}),
        name, duration_ms: to - from, ...fields },
    });
  };
  span(rootId, null, `PR CI #${run.run_number || run.id} · attempt ${run.run_attempt}`, start, end, {
    "ci.kind": "workflow", "ci.status": run.conclusion, error: failed(run.conclusion),
    "ci.job_count": jobs.length,
    "ci.carried_job_count": carriedJobs.length,
    "ci.wall_ms": end - start,
    // A partial rerun intentionally does not re-execute successful jobs.
    "ci.partial_rerun": run.run_attempt > 1,
  });
  const roots = new Map();
  const byName = new Map();
  for (const job of jobs) {
    const jobId = id(`${key}:job:${job.id}`);
    roots.set(job.id, jobId);
    byName.set(job.name.replace(/^ci \/ /, ""), job);
    const created = Math.max(start, millis(job.created_at) || start);
    const started = Math.max(created, millis(job.started_at) || created);
    const completed = Math.max(started, millis(job.completed_at) || started);
    // Include allocation wait in the job container, then distinguish it from
    // execution. Dependency wait may precede job creation; it stays visible as
    // a gap from the workflow start. GitHub does not expose a separate readyAt.
    span(jobId, rootId, job.name, Math.min(created, started), completed, {
      "ci.kind": "job", "ci.job": job.name, "ci.job_id": String(job.id),
      "ci.status": job.conclusion, error: failed(job.conclusion),
      "ci.runner": job.runner_name, "ci.runner_labels": (job.labels || []).join(","),
      "ci.start_offset_ms": started - start,
      "ci.execution_ms": Math.max(0, completed - started),
      "ci.finishes_last": completed === end,
      "ci.job_url": job.html_url,
    });
    if (started > created) span(id(`${jobId}:wait`), jobId, "Waiting for runner / scheduling", created, started, {
      "ci.kind": "wait", "ci.job": job.name,
    });
    for (const step of job.steps || []) {
      const from = millis(step.started_at);
      const to = millis(step.completed_at);
      if (from < start || to > end) continue; // skipped steps may use epoch timestamps
      span(id(`${jobId}:step:${step.number}`), jobId, step.name, from, to, {
        "ci.kind": "step", "ci.job": job.name, "ci.step": step.name,
        "ci.status": step.conclusion, error: failed(step.conclusion),
      });
    }
  }

  // Reviews, scans and other workflows on the same commit run beside this
  // workflow. They are siblings of the jobs on the same wall clock.
  const own = ownChecks(run, checks);
  const stale = run.run_attempt === 1 ? checks.length - own.length : 0;
  const pending = own.filter((check) => !check.completedAt);
  let lastEnd = end;
  let lastName = "PR workflow";
  let slowest;
  let exported = 0;
  for (const check of own) {
    const from = millis(check.startedAt);
    const to = millis(check.completedAt);
    // Skipped checks report a completion before their start; they did no work.
    if (!check.completedAt || check.status === "skipped" || !Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
    span(id(`${key}:check:${check.kind}:${check.app}:${check.name}`), rootId, check.name, from, to, {
      "ci.kind": check.kind, "ci.check": check.name, "ci.check_app": check.app,
      "ci.status": check.status, error: failed(check.status),
      "ci.start_offset_ms": from - start,
      "ci.finishes_after_workflow": to > end,
    });
    exported++;
    if (to > lastEnd) { lastEnd = to; lastName = check.name; }
    if (!slowest || to - from > slowest.ms) slowest = { name: check.name, ms: to - from };
  }
  if (pending.length) warnings.push(`${pending.length} outside checks were still running at export`);

  const receipts = new Set();
  const invocations = new Map();
  const valid = [];
  let rejected = 0;
  for (const record of records) {
    const job = byName.get(record?.job);
    if (!job || record.version !== 1 || String(record.runId) !== String(run.id)
      || String(record.attempt) !== String(run.run_attempt) || !text(record.invocation)) {
      rejected++; continue;
    }
    if (record.kind === "job") { receipts.add(job.id); continue; }
    const invocation = `${job.id}:${record.framework}:${record.invocation}`;
    if (["expected", "start", "end"].includes(record.kind)) {
      const state = invocations.get(invocation) || {};
      state[record.kind] = true;
      invocations.set(invocation, state);
      continue;
    }
    if (!["file", "test"].includes(record.kind) || !text(record.id)
      || (record.kind === "file" ? !text(record.name) : typeof record.name !== "string")
      || !text(record.file) || !["vitest", "playwright", "node"].includes(record.framework)
      || !Number.isFinite(record.start) || !Number.isFinite(record.duration) || record.duration < 0
      || record.start < millis(job.started_at) - 1000
      || record.start + record.duration > millis(job.completed_at) + 1000) {
      rejected++; continue;
    }
    valid.push({ record, job, invocation });
  }
  const recordId = ({ record, invocation }) => id(`${key}:${invocation}:${record.kind}:${record.id}`);
  const files = new Map(valid.filter(({ record }) => record.kind === "file")
    .map((entry) => [`${entry.invocation}:${entry.record.id}`, recordId(entry)]));
  for (const entry of valid) {
    const { record, job, invocation } = entry;
    const jobId = roots.get(job.id);
    // GitHub steps are ordered and have second-precision timestamps. Prefer
    // the latest containing step: rounding may also make a preceding step fit
    // a short file/test. Preserve the runner's own clock.
    const step = job.steps?.findLast((candidate) => record.start >= millis(candidate.started_at)
      && record.start + record.duration <= millis(candidate.completed_at) + 1000
      && candidate.conclusion !== "skipped");
    const parent = files.get(`${invocation}:${record.parent}`)
      || (step ? id(`${jobId}:step:${step.number}`) : jobId);
    span(recordId(entry), parent, record.kind === "test" ? record.name.slice(0, 256) : record.name, record.start, record.start + record.duration, {
      "ci.kind": record.kind, "ci.job": job.name, "test.framework": record.framework,
      "test.file": record.file, "test.status": typeof record.status === "string" ? record.status.slice(0, 32) : "unknown", error: failed(record.status),
      "test.retries": Number.isFinite(record.retries) ? record.retries : 0,
      "test.clock": record.clock === "reporter-receipt" ? "reporter-receipt" : "runner",
      ...(Number.isFinite(record.collectMs) ? { "test.collect_ms": record.collectMs } : {}),
      ...(Number.isFinite(record.setupMs) ? { "test.setup_ms": record.setupMs } : {}),
    });
  }
  // Ordinary runs skip the collection steps, so they owe no timing artifacts.
  const expectedReceipts = testDetail
    ? jobs.filter((job) => job.steps?.some((step) => step.name === "Initialize CI profile")) : [];
  const missing = expectedReceipts.filter((job) => !receipts.has(job.id));
  if (missing.length) warnings.push(`Missing timing artifacts for ${missing.length} jobs`);
  // Some package scripts invoke a reporter without using the launcher. Its
  // start/end pair proves collection even when no intent record was written.
  const incomplete = [...invocations.values()].filter((value) => !value.start || !value.end).length;
  if (incomplete) warnings.push(`${incomplete} test invocations did not finish reporting`);
  if (rejected) warnings.push(`${rejected} invalid timing records ignored`);
  if (run.conclusion !== "success") warnings.push("Workflow did not succeed; later tests or steps may not have run");
  if (!expectedReceipts.length) warnings.push("Job/step timings only; no test reporter collection steps were present");
  const root = events[0].data;
  const expectedFramework = (name) => {
    if (/General tests|Verify serialized server suites|Verify Paperclip Runner \(vitest/.test(name)) return "vitest";
    if (/e2e shard/.test(name)) return "playwright";
    if (/\/ policy$|Typecheck \+ Release Registry|Verify Paperclip Runner \(static checks/.test(name)) return "node";
    return null;
  };
  const missingTests = jobs.filter((job) => {
    const framework = expectedFramework(job.name);
    return framework && !valid.some((entry) => entry.job.id === job.id && entry.record.framework === framework);
  });
  if (expectedReceipts.length && missingTests.length) warnings.push(`Missing test detail for ${missingTests.length} test jobs (including jobs that failed before testing)`);
  root["ci.sample_rate"] = sampleRate;
  root["ci.workflow_ms"] = end - start;
  // Push to the last finished check. Checks still running at export are excluded and counted.
  root["ci.all_checks_ms"] = lastEnd - start;
  root["ci.last_to_finish"] = lastName;
  root["ci.check_count"] = exported;
  root["ci.pending_check_count"] = pending.length;
  root["ci.pending_checks"] = pending.map((check) => check.name).join(", ").slice(0, 1024);
  root["ci.earlier_check_count"] = stale;
  if (slowest) {
    root["ci.slowest_check"] = slowest.name;
    root["ci.slowest_check_ms"] = slowest.ms;
  }
  root["ci.test_count"] = valid.filter(({ record }) => record.kind === "test").length;
  root["ci.file_count"] = valid.filter(({ record }) => record.kind === "file").length;
  root["ci.expected_invocations"] = invocations.size;
  root["ci.reported_invocations"] = [...invocations.values()].filter((value) => value.start && value.end).length;
  root["ci.profile_complete"] = warnings.length === 0 && run.run_attempt === 1;
  root["ci.coverage_warnings"] = warnings.join("; ");
  return { traceId, events, warnings, wallMs: end - start, windowMs: lastEnd - start, jobCount: jobs.length, checkCount: exported };
}

export function traceUrl(team, environment, dataset, trace) {
  const params = new URLSearchParams({
    trace_id: trace.traceId,
    trace_start_ts: String(Math.floor(Date.parse(trace.events[0].time) / 1000)),
    trace_end_ts: String(Math.ceil((Date.parse(trace.events[0].time) + (trace.windowMs ?? trace.wallMs)) / 1000)),
  });
  return `https://ui.honeycomb.io/${encodeURIComponent(team)}/environments/${encodeURIComponent(environment)}/datasets/${encodeURIComponent(dataset)}/trace?${params}`;
}
