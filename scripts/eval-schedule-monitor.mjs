import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

export const MONITORED_REPOSITORY = "paperclipai/paperclip";
export const MONITORED_WORKFLOW = "runner-full-stack-e2e.yml";
export const MONITORED_SCHEDULES = { daily: "47 8 * * *", weekly: "47 9 * * 0" };
const hour = 3_600_000;
const prefix = `repos/${MONITORED_REPOSITORY}/actions`;
const numericId = value => Number.isSafeInteger(value) && value > 0;

export function expectedCampaign(cadence, now, enabledAt) {
  if (!Object.hasOwn(MONITORED_SCHEDULES, cadence) || !Number.isFinite(now) || !Number.isFinite(enabledAt)) {
    throw new Error("Invalid monitor schedule input");
  }
  const due = new Date(now - 90 * 60_000);
  due.setUTCHours(cadence === "daily" ? 8 : 9, 47, 0, 0);
  if (due.getTime() > now - 90 * 60_000) due.setUTCDate(due.getUTCDate() - 1);
  if (cadence === "weekly") due.setUTCDate(due.getUTCDate() - due.getUTCDay());
  return due.getTime() >= enabledAt ? due.toISOString() : undefined;
}

function signal(cadence, status, dueAt, runId) {
  return { cadence, status, ...(dueAt ? { dueAt } : {}), ...(runId ? {
    runId, url: `https://github.com/${MONITORED_REPOSITORY}/actions/runs/${runId}`,
  } : {}) };
}

export async function inspectEvalSchedule({ get, now = Date.now() }) {
  const observations = [];
  try {
    const variables = await get(`${prefix}/variables?per_page=100`);
    if (!Array.isArray(variables.variables) || !Number.isSafeInteger(variables.total_count)
      || variables.total_count !== variables.variables.length) throw new Error("Incomplete variables");
    const values = Object.fromEntries(variables.variables.map(row => [row.name, row.value]));
    if (values.RUNNER_FULL_STACK_E2E_NIGHTLY_ENABLED !== "true") {
      return { observedAt: new Date(now).toISOString(), status: "disabled", observations: [] };
    }
    if (values.RUNNER_FULL_STACK_E2E_OPERATIONS_ENABLED !== "true") {
      return { observedAt: new Date(now).toISOString(), status: "configuration_incomplete",
        reason: "legacy_schedule_enabled_without_budget_gate", observations: [] };
    }
    const enabledAt = Date.parse(values.RUNNER_FULL_STACK_E2E_OPERATIONS_ENABLED_AT ?? "");
    if (!Number.isFinite(enabledAt) || enabledAt > now) {
      return { observedAt: new Date(now).toISOString(), status: "configuration_incomplete", observations: [] };
    }
    const workflow = await get(`${prefix}/workflows/${MONITORED_WORKFLOW}`);
    if (workflow.path !== `.github/workflows/${MONITORED_WORKFLOW}` || !numericId(workflow.id)) throw new Error("Wrong workflow");
    if (workflow.state !== "active") return { observedAt: new Date(now).toISOString(), status: "workflow_disabled", observations: [] };
    const expected = Object.keys(MONITORED_SCHEDULES).map(cadence => ({ cadence, dueAt: expectedCampaign(cadence, now, enabledAt) }));
    const due = expected.filter(row => row.dueAt);
    if (!due.length) return { observedAt: new Date(now).toISOString(), status: "waiting", observations: [] };
    const since = due.map(row => row.dueAt).sort()[0];
    const runs = await get(`${prefix}/workflows/${MONITORED_WORKFLOW}/runs?event=schedule&per_page=100&created=${encodeURIComponent(`>=${since}`)}`);
    if (!Array.isArray(runs.workflow_runs) || !Number.isSafeInteger(runs.total_count)
      || runs.total_count !== runs.workflow_runs.length) throw new Error("Incomplete runs");
    for (const { cadence, dueAt } of expected) {
      if (!dueAt) { observations.push(signal(cadence, "waiting")); continue; }
      const matches = runs.workflow_runs.filter(run => run.event === "schedule" && run.workflow_id === workflow.id
        && run.display_title === `Runner Full-Stack E2E / ${MONITORED_SCHEDULES[cadence]}`
        && Date.parse(run.created_at) >= Date.parse(dueAt) && Date.parse(run.created_at) <= now
        && Date.parse(run.created_at) < Date.parse(dueAt) + (cadence === "daily" ? 24 : 168) * hour);
      if (!matches.length) { observations.push(signal(cadence, "missing", dueAt)); continue; }
      if (matches.length !== 1) { observations.push(signal(cadence, "ambiguous_runs", dueAt)); continue; }
      const run = matches[0];
      if (!numericId(run.id) || !numericId(run.run_attempt) || typeof run.status !== "string") throw new Error("Invalid run identity");
      if (run.run_attempt !== 1) { observations.push(signal(cadence, "unexpected_retry", dueAt, run.id)); continue; }
      if (run.status !== "completed") {
        observations.push(signal(cadence, now - Date.parse(run.created_at) > 4 * hour ? "overdue" : "running", dueAt, run.id));
        continue;
      }
      if (run.conclusion !== "success") { observations.push(signal(cadence, "failed", dueAt, run.id)); continue; }
      const artifacts = await get(`${prefix}/runs/${run.id}/artifacts?per_page=100`);
      if (!Array.isArray(artifacts.artifacts) || !Number.isSafeInteger(artifacts.total_count)
        || artifacts.total_count !== artifacts.artifacts.length) throw new Error("Incomplete artifacts");
      const reports = artifacts.artifacts.filter(row => row.name === `runner-e2e-report-${run.id}-1`
        && row.expired === false && Number.isSafeInteger(row.size_in_bytes) && row.size_in_bytes > 0);
      observations.push(signal(cadence, reports.length === 1 ? "healthy" : "missing_report", dueAt, run.id));
    }
    return { observedAt: new Date(now).toISOString(), status: "observed", observations };
  } catch {
    return { observedAt: new Date(now).toISOString(), status: "api_unavailable", observations };
  }
}

const quiet = new Set(["disabled", "waiting", "running", "healthy"]);
const statuses = new Set([...quiet, "observed", "configuration_incomplete", "workflow_disabled", "api_unavailable",
  "missing", "ambiguous_runs", "unexpected_retry", "overdue", "failed", "missing_report"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const timestamp = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const notificationId = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const signalKey = row => !quiet.has(row.status) ? JSON.stringify([row.status, row.dueAt ?? null, row.runId ?? null]) : row.status;
const validSignal = row => object(row) && ["monitor", "daily", "weekly"].includes(row.cadence) && statuses.has(row.status)
  && (row.dueAt === undefined || timestamp(row.dueAt)) && (row.runId === undefined || numericId(row.runId))
  && (row.runId === undefined ? row.url === undefined : row.url === `https://github.com/${MONITORED_REPOSITORY}/actions/runs/${row.runId}`);

function validateState(previous) {
  if (!object(previous) || previous.version !== 1 || previous.repository !== MONITORED_REPOSITORY
    || previous.workflow !== MONITORED_WORKFLOW || !object(previous.signals)
    || !timestamp(previous.checkedAt) || !(previous.lastSuccessfulInspectionAt === null || timestamp(previous.lastSuccessfulInspectionAt))
    || !object(previous.lastInspectedRunIds) || Object.entries(previous.lastInspectedRunIds).some(([cadence, id]) => !["daily", "weekly"].includes(cadence) || !numericId(id))
    || Object.entries(previous.signals).some(([cadence, row]) => !validSignal(row) || row.cadence !== cadence
      || row.issue !== !quiet.has(row.status) || row.key !== signalKey(row))
    || !Array.isArray(previous.notifications) || previous.notifications.some(row => !validSignal(row)
      || !notificationId(row.id) || !["problem", "recovery"].includes(row.kind))
    || new Set(previous.notifications.map(row => row.id)).size !== previous.notifications.length) {
    throw new Error("Invalid retained monitor state; refusing to reset notification history");
  }
}

export function monitorTransition(previous, inspection) {
  if (previous !== undefined) validateState(previous);
  const current = inspection.status === "observed" ? inspection.observations : [signal("monitor", inspection.status)];
  const signals = {}, notifications = [];
  const prior = previous?.signals ?? {};
  for (const row of current) {
    const issue = !quiet.has(row.status);
    const key = signalKey(row);
    signals[row.cadence] = { ...row, issue, key };
    if (issue && prior[row.cadence]?.key !== key) notifications.push({ kind: "problem", ...row });
    else if (!issue && prior[row.cadence]?.issue && row.status !== "disabled") notifications.push({ kind: "recovery", ...row });
  }
  if (inspection.status === "observed" && prior.monitor?.issue) notifications.push({ kind: "recovery", cadence: "monitor", status: "observed" });
  const readable = !["api_unavailable", "configuration_incomplete"].includes(inspection.status);
  return { version: 1, repository: MONITORED_REPOSITORY, workflow: MONITORED_WORKFLOW,
    checkedAt: inspection.observedAt,
    lastSuccessfulInspectionAt: readable ? inspection.observedAt : previous?.lastSuccessfulInspectionAt ?? null,
    lastInspectedRunIds: { ...previous?.lastInspectedRunIds,
      ...Object.fromEntries(inspection.observations.filter(row => row.runId).map(row => [row.cadence, row.runId])) },
    signals: inspection.status === "observed" || quiet.has(inspection.status) ? signals : { ...prior, ...signals },
    notifications: [...previous?.notifications ?? [], ...notifications.map(row => ({ id: randomUUID(), ...row }))] };
}

async function saveState(stateFile, next) {
  await mkdir(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  await writeFile(`${stateFile}.pending`, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  await rename(`${stateFile}.pending`, stateFile);
}

export async function acknowledgeEvalNotifications(stateFile, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => !notificationId(id))) throw new Error("Invalid notification acknowledgments");
  const previous = JSON.parse(await readFile(stateFile, "utf8"));
  validateState(previous);
  const next = { ...previous, notifications: previous.notifications.filter(row => !ids.includes(row.id)) };
  await saveState(stateFile, next);
  return { acknowledged: previous.notifications.length - next.notifications.length, pending: next.notifications.length };
}

export async function runEvalMonitor(stateFile, get, now = Date.now()) {
  let previous;
  try { previous = JSON.parse(await readFile(stateFile, "utf8")); validateState(previous); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const inspection = await inspectEvalSchedule({ get, now });
  const next = monitorTransition(previous, inspection);
  await saveState(stateFile, next);
  return { ...inspection, lastSuccessfulInspectionAt: next.lastSuccessfulInspectionAt,
    lastInspectedRunIds: next.lastInspectedRunIds, notifications: next.notifications };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 && !(process.argv[3] === "--ack" && process.argv.length >= 5)) {
    throw new Error("Usage: node scripts/eval-schedule-monitor.mjs <private-state-file> [--ack <notification-id> ...]");
  }
  const execute = promisify(execFile);
  const get = async endpoint => {
    if (!endpoint.startsWith(`${prefix}/`)) throw new Error("Unapproved monitor endpoint");
    const { stdout } = await execute("gh", ["api", "--method", "GET", endpoint], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  console.log(JSON.stringify(process.argv[3] === "--ack"
    ? await acknowledgeEvalNotifications(path.resolve(process.argv[2]), process.argv.slice(4))
    : await runEvalMonitor(path.resolve(process.argv[2]), get), null, 2));
}
