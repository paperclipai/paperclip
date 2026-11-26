import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acknowledgeEvalNotifications, expectedCampaign, inspectEvalSchedule, monitorTransition, runEvalMonitor, MONITORED_SCHEDULES } from "../eval-schedule-monitor.mjs";

const now = Date.parse("2026-10-25T13:00:00Z");
const enabledAt = "2026-10-24T00:00:00Z";
const variables = { total_count: 3, variables: [
  { name: "RUNNER_FULL_STACK_E2E_OPERATIONS_ENABLED", value: "true" },
  { name: "RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED", value: "true" },
  { name: "RUNNER_FULL_STACK_E2E_OPERATIONS_ENABLED_AT", value: enabledAt },
] };
const workflow = { id: 17, path: ".github/workflows/runner-full-stack-e2e.yml", state: "active" };
const run = (cadence, id, extra = {}) => ({ id, workflow_id: 17, run_attempt: 1, event: "schedule", status: "completed", conclusion: "success",
  display_title: `Runner Full-Stack E2E / ${MONITORED_SCHEDULES[cadence]}`,
  created_at: cadence === "daily" ? "2026-10-25T08:50:00Z" : "2026-10-25T09:50:00Z", ...extra });
function fixture(overrides = {}) {
  const calls = [];
  const get = async endpoint => {
    calls.push(endpoint);
    if (endpoint.includes("/variables?")) return overrides.variables ?? structuredClone(variables);
    if (endpoint.endsWith("runner-full-stack-e2e.yml")) return overrides.workflow ?? workflow;
    if (endpoint.includes("/runs?")) {
      const workflow_runs = overrides.runs ?? [run("daily", 101), run("weekly", 102)];
      return { total_count: overrides.total_count ?? workflow_runs.length, workflow_runs };
    }
    if (endpoint.includes("/artifacts?")) {
      const id = Number(endpoint.match(/\/runs\/(\d+)\//)[1]);
      const artifacts = overrides.artifacts ?? [{ name: `runner-e2e-report-${id}-1`, expired: false, size_in_bytes: 100 }];
      return { artifacts, total_count: artifacts.length };
    }
    throw new Error("Unexpected read");
  };
  return { get, calls };
}

test("UTC due windows honor grace, activation and the weekly boundary", () => {
  assert.equal(expectedCampaign("daily", now, Date.parse(enabledAt)), "2026-10-25T08:47:00.000Z");
  assert.equal(expectedCampaign("weekly", now, Date.parse(enabledAt)), "2026-10-25T09:47:00.000Z");
  assert.equal(expectedCampaign("weekly", Date.parse("2026-10-25T10:00:00Z"), Date.parse(enabledAt)), undefined);
  assert.equal(expectedCampaign("daily", now, now), undefined);
  assert.equal(expectedCampaign("daily", Date.parse("2026-11-01T10:17:00Z"), 0), "2026-11-01T08:47:00.000Z");
});

test("disabled gates do not query or diagnose old paid campaigns", async () => {
  const f = fixture({ variables: { total_count: 0, variables: [] } });
  assert.equal((await inspectEvalSchedule({ ...f, now })).status, "disabled");
  assert.equal(f.calls.length, 1);
});

for (const budgetGate of [undefined, "false"]) test(`an enabled legacy schedule with ${budgetGate ?? "missing"} budget gate alerts once`, async () => {
  const rows = [{ name: "RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED", value: "true" }];
  if (budgetGate !== undefined) rows.push({ name: "RUNNER_FULL_STACK_E2E_OPERATIONS_ENABLED", value: budgetGate });
  const f = fixture({ variables: { total_count: rows.length, variables: rows } });
  const inspection = await inspectEvalSchedule({ ...f, now });
  assert.equal(inspection.status, "configuration_incomplete");
  assert.equal(inspection.reason, "legacy_schedule_enabled_without_budget_gate");
  assert.equal(f.calls.length, 1);
  const first = monitorTransition(undefined, inspection);
  assert.equal(first.notifications.length, 1);
  assert.equal(first.notifications[0].kind, "problem");
  assert.deepEqual(monitorTransition(first, inspection).notifications, first.notifications);
});

test("an explicitly disabled legacy gate stays quiet even if the new budget gate is enabled", async () => {
  const changed = structuredClone(variables); changed.variables[1].value = "false";
  const f = fixture({ variables: changed });
  const inspection = await inspectEvalSchedule({ ...f, now });
  assert.equal(inspection.status, "disabled"); assert.equal(f.calls.length, 1);
  assert.deepEqual(monitorTransition(undefined, inspection).notifications, []);
});

test("missing activation time and a disabled workflow stay distinct from missing runs", async () => {
  const invalid = structuredClone(variables); invalid.variables[2].value = "not a date";
  assert.equal((await inspectEvalSchedule({ ...fixture({ variables: invalid }), now })).status, "configuration_incomplete");
  assert.equal((await inspectEvalSchedule({ ...fixture({ workflow: { ...workflow, state: "disabled_inactivity" } }), now })).status, "workflow_disabled");
});

test("requires one completed scheduled campaign and its unexpired report for each cadence", async () => {
  const result = await inspectEvalSchedule({ ...fixture(), now });
  assert.deepEqual(result.observations.map(row => row.status), ["healthy", "healthy"]);
  assert.deepEqual(result.observations.map(row => row.runId), [101, 102]);
  assert.deepEqual(monitorTransition(undefined, result).notifications, []);
});

for (const [name, overrides, status] of [
  ["no campaign", { runs: [] }, "missing"],
  ["manual run cannot substitute for schedule", { runs: [run("daily", 101, { event: "workflow_dispatch" })] }, "missing"],
  ["failed campaign", { runs: [run("daily", 101, { conclusion: "failure" })] }, "failed"],
  ["canceled campaign", { runs: [run("daily", 101, { conclusion: "cancelled" })] }, "failed"],
  ["overdue queued campaign", { runs: [run("daily", 101, { status: "queued" })] }, "overdue"],
  ["unexpected paid rerun", { runs: [run("daily", 101, { run_attempt: 2 })] }, "unexpected_retry"],
  ["multiple matching runs", { runs: [run("daily", 101), run("daily", 103)] }, "ambiguous_runs"],
  ["missing report", { artifacts: [] }, "missing_report"],
  ["expired report", { artifacts: [{ name: "runner-e2e-report-101-1", expired: true, size_in_bytes: 100 }] }, "missing_report"],
  ["empty report", { artifacts: [{ name: "runner-e2e-report-101-1", expired: false, size_in_bytes: 0 }] }, "missing_report"],
]) test(name, async () => {
  const result = await inspectEvalSchedule({ ...fixture(overrides), now });
  assert.equal(result.observations[0].status, status);
});

test("new-day early run does not collide with the prior day during grace", async () => {
  const runs = [run("daily", 100, { created_at: "2026-10-24T08:50:00Z" }), run("daily", 101)];
  const result = await inspectEvalSchedule({ ...fixture({ runs }), now: Date.parse("2026-10-25T09:00:00Z") });
  assert.equal(result.observations[0].runId, 100);
  assert.equal(result.observations[0].status, "healthy");
});

test("running is quiet inside the runtime limit", async () => {
  const result = await inspectEvalSchedule({ ...fixture({ runs: [run("daily", 101, { status: "in_progress", created_at: "2026-10-25T10:00:00Z" })] }), now });
  assert.equal(result.observations[0].status, "running");
});

test("API errors and incomplete lists cannot imply a missing or successful run", async () => {
  assert.equal((await inspectEvalSchedule({ ...fixture({ total_count: 101 }), now })).status, "api_unavailable");
  assert.equal((await inspectEvalSchedule({ get: async () => { throw new Error("private upstream body"); }, now })).status, "api_unavailable");
});

test("alerts once per incident and recovery while keeping last observed run IDs through API failure", async () => {
  const failed = await inspectEvalSchedule({ ...fixture({ runs: [run("daily", 101, { conclusion: "failure" }), run("weekly", 102)] }), now });
  const first = monitorTransition(undefined, failed);
  assert.equal(first.notifications.length, 1);
  assert.deepEqual(monitorTransition(first, failed).notifications, first.notifications);
  const outage = { observedAt: new Date(now + 1000).toISOString(), status: "api_unavailable", observations: [] };
  const unavailable = monitorTransition({ ...first, notifications: [] }, outage);
  assert.equal(unavailable.lastSuccessfulInspectionAt, first.lastSuccessfulInspectionAt);
  assert.deepEqual(unavailable.lastInspectedRunIds, { daily: 101, weekly: 102 });
  assert.equal(unavailable.notifications[0].status, "api_unavailable");
  assert.deepEqual(monitorTransition(unavailable, outage).notifications, unavailable.notifications);
  const resumed = monitorTransition({ ...unavailable, notifications: [] }, failed);
  assert.deepEqual(resumed.notifications.map(row => [row.kind, row.cadence]), [["recovery", "monitor"]]);
  const healthy = monitorTransition({ ...resumed, notifications: [] }, await inspectEvalSchedule({ ...fixture(), now }));
  assert.deepEqual(healthy.notifications.map(row => [row.kind, row.cadence]), [["recovery", "daily"]]);
});

test("persists private state across invocations and refuses corrupt history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-monitor-"));
  try {
    const file = path.join(directory, "state.json");
    const first = await runEvalMonitor(file, fixture({ runs: [] }).get, now);
    assert.equal(first.notifications.length, 2);
    const repeated = await runEvalMonitor(file, fixture({ runs: [] }).get, now);
    assert.deepEqual(repeated.notifications, first.notifications);
    assert.deepEqual(await acknowledgeEvalNotifications(file, [first.notifications[0].id]), { acknowledged: 1, pending: 1 });
    const afterPartialDelivery = await runEvalMonitor(file, fixture({ runs: [] }).get, now);
    assert.deepEqual(afterPartialDelivery.notifications, first.notifications.slice(1));
    assert.deepEqual(await acknowledgeEvalNotifications(file, first.notifications.map(row => row.id)), { acknowledged: 1, pending: 0 });
    assert.deepEqual((await runEvalMonitor(file, fixture({ runs: [] }).get, now)).notifications, []);
    assert.equal(JSON.parse(await readFile(file, "utf8")).repository, "paperclipai/paperclip");
    await writeFile(file, "bad history");
    await assert.rejects(runEvalMonitor(file, fixture().get, now));
    assert.equal(await readFile(file, "utf8"), "bad history");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("pending alerts survive later recovery and are acknowledged only after delivery", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-monitor-outbox-"));
  try {
    const file = path.join(directory, "state.json");
    const lostOutput = await runEvalMonitor(file, fixture({ runs: [] }).get, now);
    const recovered = await runEvalMonitor(file, fixture().get, now + 1000);
    assert.deepEqual(recovered.notifications.slice(0, 2), lostOutput.notifications);
    assert.deepEqual(recovered.notifications.map(row => row.kind), ["problem", "problem", "recovery", "recovery"]);
    const unchanged = await runEvalMonitor(file, fixture().get, now + 2000);
    assert.deepEqual(unchanged.notifications, recovered.notifications);
    await assert.rejects(acknowledgeEvalNotifications(file, ["invalid"]));
    assert.deepEqual(await acknowledgeEvalNotifications(file, recovered.notifications.map(row => row.id)), { acknowledged: 4, pending: 0 });
    assert.deepEqual((await runEvalMonitor(file, fixture().get, now + 3000)).notifications, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects valid JSON with malformed history without querying or overwriting it", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-monitor-corrupt-"));
  try {
    const file = path.join(directory, "state.json");
    await runEvalMonitor(file, fixture().get, now);
    const valid = JSON.parse(await readFile(file, "utf8"));
    for (const malformed of [null, false, 0, [], {}, { ...valid, signals: [] }, { ...valid, signals: { daily: null } },
      { ...valid, notifications: null }, { ...valid, notifications: [{ id: "invalid" }] }]) {
      const original = JSON.stringify(malformed);
      await writeFile(file, original);
      const f = fixture();
      await assert.rejects(runEvalMonitor(file, f.get, now), /Invalid retained monitor state/);
      assert.equal(f.calls.length, 0);
      assert.equal(await readFile(file, "utf8"), original);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("workflow titles carry the literal schedule used to distinguish daily and weekly runs", async () => {
  const text = await readFile(new URL("../../.github/workflows/runner-full-stack-e2e.yml", import.meta.url), "utf8");
  assert.ok(text.includes("run-name: Runner Full-Stack E2E / ${{ github.event.schedule || inputs.cadence || 'manual' }}"));
  for (const cron of Object.values(MONITORED_SCHEDULES)) assert.ok(text.includes(`cron: "${cron}"`));
});
