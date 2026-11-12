import fs from "node:fs/promises";
import path from "node:path";
import {
  readProcessStartedAtMs,
  readRunProcessTableAsync,
  RunProcessLineage,
  terminateRunMarkedProcesses,
  type RunDescendantTerminateResult,
} from "@paperclipai/adapter-utils/run-descendants";
import { logger } from "../../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { listLocalServiceRegistryRecords } from "../local-service-supervisor.js";

export const RUN_DESCENDANT_DEFAULT_GRACE_MS = 5_000;
export const RUN_LINEAGE_SAMPLE_INTERVAL_MS = 250;

/**
 * Lineage of live local legacy runs. One shared timer reads the process table
 * and records each run's processes, so a process that later clears its
 * environment or is reparented stays owned by its run. Each run's lineage is
 * also saved to a small file, so a cancel or recovery after a server restart
 * still knows what the run started.
 */
const trackedRuns = new Map<string, RunProcessLineage>();
let sampleTimer: NodeJS.Timeout | null = null;
let sampleIntervalMs = RUN_LINEAGE_SAMPLE_INTERVAL_MS;

function lineageDir() {
  return path.resolve(resolvePaperclipInstanceRoot(), "run-lineage");
}

function lineagePath(runId: string) {
  // Run ids are UUIDs; refuse anything that could leave the directory.
  if (!/^[A-Za-z0-9-]{1,128}$/.test(runId)) return null;
  return path.resolve(lineageDir(), `${runId}.json`);
}

async function saveLineage(lineage: RunProcessLineage) {
  const file = lineagePath(lineage.runId);
  if (!file) return;
  try {
    await fs.mkdir(lineageDir(), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(lineage.toSnapshot()), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (err) {
    logger.warn({ err, runId: lineage.runId }, "failed to save run process lineage");
  }
}

async function loadLineage(runId: string) {
  const file = lineagePath(runId);
  if (!file) return null;
  try {
    const lineage = RunProcessLineage.fromSnapshot(JSON.parse(await fs.readFile(file, "utf8")));
    return lineage && lineage.runId === runId ? lineage : null;
  } catch {
    return null;
  }
}

async function removeLineage(runId: string) {
  const file = lineagePath(runId);
  if (!file) return;
  try {
    await fs.rm(file, { force: true });
  } catch {
    // Best effort; a stale file only adds identities that are checked again.
  }
}

// All procfs and file work is asynchronous, and a sample never overlaps the
// previous one, so a slow host or slow storage delays the next sample rather
// than the server's other work.
let sampleInFlight: Promise<void> | null = null;

async function sampleTrackedRunsOnce() {
  if (trackedRuns.size === 0) return;
  try {
    const table = await readRunProcessTableAsync();
    for (const lineage of [...trackedRuns.values()]) {
      await lineage.sampleAsync(table);
      if (lineage.takeChanged() && trackedRuns.get(lineage.runId) === lineage) await saveLineage(lineage);
    }
  } catch (err) {
    logger.warn({ err }, "failed to sample run process lineage");
  }
}

function sampleTrackedRuns() {
  if (sampleInFlight) return sampleInFlight;
  sampleInFlight = sampleTrackedRunsOnce().finally(() => {
    sampleInFlight = null;
  });
  return sampleInFlight;
}

function ensureSampler() {
  if (sampleTimer || trackedRuns.size === 0) return;
  sampleTimer = setInterval(() => void sampleTrackedRuns(), sampleIntervalMs);
  sampleTimer.unref();
}

function stopSamplerIfIdle() {
  if (trackedRuns.size > 0 || !sampleTimer) return;
  clearInterval(sampleTimer);
  sampleTimer = null;
}

/** Test seam: sampling interval for runs tracked after this call. */
export function setRunLineageSampleIntervalForTests(ms: number | null) {
  sampleIntervalMs = ms ?? RUN_LINEAGE_SAMPLE_INTERVAL_MS;
  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
    ensureSampler();
  }
}

/**
 * Test seam: drops in-memory lineage without touching the saved files, as a
 * server restart does.
 */
export function forgetTrackedRunLineageForTests() {
  trackedRuns.clear();
  stopSamplerIfIdle();
}

/**
 * Starts recording a local legacy run's processes. `rootPid` is the CLI the
 * adapter spawned. Safe to call more than once for the same run.
 */
export async function trackRunDescendants(input: { runId: string; rootPid?: number | null }) {
  try {
    let lineage = trackedRuns.get(input.runId);
    const isNew = !lineage;
    if (!lineage) {
      lineage = new RunProcessLineage(input.runId);
      trackedRuns.set(input.runId, lineage);
    }
    // Record the CLI before any await: if it exits first, its start time can
    // no longer be read, and a child left in its session would lose its link
    // to the run.
    if (typeof input.rootPid === "number") lineage.addRoot(input.rootPid);
    if (isNew) {
      const saved = await loadLineage(input.runId);
      // Reaped while the saved file was read: do not track it again.
      if (trackedRuns.get(input.runId) !== lineage) return;
      if (saved) lineage.absorb(saved);
    }
    ensureSampler();
    await lineage.sampleAsync(await readRunProcessTableAsync());
    if (lineage.takeChanged() && trackedRuns.get(input.runId) === lineage) await saveLineage(lineage);
  } catch (err) {
    logger.warn({ err, runId: input.runId }, "failed to start run process lineage");
  }
}

// A registered service's process started before (or, for a new spawn,
// just before) its record was written. Allow for clock-tick precision and the
// time between spawn and the record write.
const REGISTRY_START_TOLERANCE_MS = 5_000;

/**
 * PIDs and process groups that a registered local service still owns. A
 * record is honoured only while its PID (or group leader) is the process it
 * described: a process that started after the record was written has reused
 * the PID, so it is not excluded. A group whose leader is gone keeps its
 * exclusion, because Linux does not reuse a group id while members remain.
 */
export function registeredServiceExclusions(
  records: Array<{ pid: number; processGroupId: number | null; startedAt: string }>,
  readStartedAtMs: (pid: number) => number | null = (pid) => readProcessStartedAtMs(pid),
) {
  const pids: number[] = [];
  const processGroupIds: number[] = [];
  for (const record of records) {
    const recordedAtMs = Date.parse(record.startedAt);
    const isRecordedProcess = (pid: number) => {
      const startedAtMs = readStartedAtMs(pid);
      if (startedAtMs === null) return null;
      return Number.isFinite(recordedAtMs) && startedAtMs <= recordedAtMs + REGISTRY_START_TOLERANCE_MS;
    };
    if (Number.isInteger(record.pid) && record.pid > 0 && isRecordedProcess(record.pid) === true) {
      pids.push(record.pid);
    }
    const pgid = record.processGroupId;
    if (typeof pgid === "number" && Number.isInteger(pgid) && pgid > 0 && isRecordedProcess(pgid) !== false) {
      processGroupIds.push(pgid);
    }
  }
  return { pids, processGroupIds };
}

/**
 * Stops processes a local legacy run left behind after its CLI process group
 * was handled. It uses the run's recorded lineage (in memory, or the saved
 * file after a restart) and the run id marker, so it also works for a cancel
 * after a server restart. Processes that a registered local service owns are
 * excluded, so a server-managed runtime service is never stopped here.
 * Failures are logged and never thrown: teardown must not block run settlement.
 */
export async function reapRunDescendants(input: {
  runId: string;
  graceMs?: number;
  reason: string;
}): Promise<RunDescendantTerminateResult | null> {
  const tracked = trackedRuns.get(input.runId);
  trackedRuns.delete(input.runId);
  stopSamplerIfIdle();
  try {
    const lineage = tracked ?? (await loadLineage(input.runId)) ?? new RunProcessLineage(input.runId);
    const exclusions = registeredServiceExclusions(await listLocalServiceRegistryRecords());
    const result = await terminateRunMarkedProcesses(input.runId, {
      lineage,
      graceMs: input.graceMs ?? RUN_DESCENDANT_DEFAULT_GRACE_MS,
      excludePids: exclusions.pids,
      excludeProcessGroupIds: exclusions.processGroupIds,
    });
    if (result.survivors.length === 0) await removeLineage(input.runId);
    else await saveLineage(lineage);
    if (result.found.length > 0) {
      const log = result.survivors.length > 0 ? logger.warn.bind(logger) : logger.info.bind(logger);
      log(
        {
          runId: input.runId,
          reason: input.reason,
          found: result.found.map((entry) => entry.pid),
          forceKilled: result.forceKilled.map((entry) => entry.pid),
          survivors: result.survivors.map((entry) => entry.pid),
        },
        result.survivors.length > 0
          ? "run descendant processes survived SIGKILL"
          : "stopped run descendant processes left after the run",
      );
    }
    return result;
  } catch (err) {
    logger.warn({ err, runId: input.runId, reason: input.reason }, "failed to reap run descendant processes");
    return null;
  }
}
