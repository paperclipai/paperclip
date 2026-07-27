import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipHomeDir } from "../home-paths.js";

export const HOT_RESTART_INTENT_FILENAME = "hot-restart-intent.json";
export const HOT_RESTART_REPORT_FILENAME = "hot-restart-report.json";

export type HotRestartIntentRun = {
  runId: string;
  companyId: string;
  agentId: string;
  adapterType: string;
  status: string;
  processPid: number | null;
  processGroupId: number | null;
  issueId: string | null;
};

export type HotRestartIntent = {
  version: 1;
  requestedAt: string;
  previousServerPid: number;
  previousServerVersion: string | null;
  drainRequired: boolean;
  requestedByRunId: string | null;
  shutdownSnapshot?: {
    capturedAt: string;
    signal: "SIGINT" | "SIGTERM";
    activeRuns: HotRestartIntentRun[];
  };
};

export type HotRestartReportRun = HotRestartIntentRun & {
  classification:
    | "adopted"
    | "finalized_while_down"
    | "lost"
    | "skipped";
  reason: string;
};

export type HotRestartReport = {
  version: 1;
  requestedAt: string;
  completedAt: string;
  drainRequired: boolean;
  previousServerPid: number;
  newServerPid: number;
  previousServerVersion: string | null;
  newServerVersion: string;
  adoptedRunIds: string[];
  finalizedWhileDownRunIds: string[];
  lostRunIds: string[];
  skippedRunIds: string[];
  runs: HotRestartReportRun[];
};

function resolveHotRestartPath(filename: string, homeDir?: string) {
  return path.join(resolvePaperclipHomeDir(homeDir), filename);
}

export function resolveHotRestartIntentPath(homeDir?: string) {
  return resolveHotRestartPath(HOT_RESTART_INTENT_FILENAME, homeDir);
}

export function resolveHotRestartReportPath(homeDir?: string) {
  return resolveHotRestartPath(HOT_RESTART_REPORT_FILENAME, homeDir);
}

async function writeJsonFileAtomic(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function parseRun(value: unknown): HotRestartIntentRun | null {
  if (!isRecord(value)) return null;
  const runId = asString(value.runId);
  const companyId = asString(value.companyId);
  const agentId = asString(value.agentId);
  const adapterType = asString(value.adapterType);
  const status = asString(value.status);
  if (!runId || !companyId || !agentId || !adapterType || !status) return null;
  return {
    runId,
    companyId,
    agentId,
    adapterType,
    status,
    processPid: asNumber(value.processPid),
    processGroupId: asNumber(value.processGroupId),
    issueId: asString(value.issueId),
  };
}

export function parseHotRestartIntent(value: unknown): HotRestartIntent | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const requestedAt = asString(value.requestedAt);
  const previousServerPid = asNumber(value.previousServerPid);
  if (!requestedAt || !previousServerPid) return null;

  const intent: HotRestartIntent = {
    version: 1,
    requestedAt,
    previousServerPid,
    previousServerVersion: asString(value.previousServerVersion),
    drainRequired: asBoolean(value.drainRequired),
    requestedByRunId: asString(value.requestedByRunId),
  };

  const snapshot = isRecord(value.shutdownSnapshot) ? value.shutdownSnapshot : null;
  const signal = snapshot?.signal === "SIGINT" || snapshot?.signal === "SIGTERM"
    ? snapshot.signal
    : null;
  const capturedAt = asString(snapshot?.capturedAt);
  const activeRuns = Array.isArray(snapshot?.activeRuns)
    ? snapshot.activeRuns.map(parseRun).filter((run): run is HotRestartIntentRun => run !== null)
    : [];
  if (signal && capturedAt) {
    intent.shutdownSnapshot = { capturedAt, signal, activeRuns };
  }

  return intent;
}

export async function readHotRestartIntent(homeDir?: string) {
  try {
    const raw = await fs.readFile(resolveHotRestartIntentPath(homeDir), "utf8");
    return parseHotRestartIntent(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeHotRestartIntent(input: {
  previousServerPid: number;
  previousServerVersion?: string | null;
  drainRequired?: boolean;
  requestedByRunId?: string | null;
  requestedAt?: Date;
  homeDir?: string;
}) {
  const intent: HotRestartIntent = {
    version: 1,
    requestedAt: (input.requestedAt ?? new Date()).toISOString(),
    previousServerPid: input.previousServerPid,
    previousServerVersion: input.previousServerVersion ?? null,
    drainRequired: input.drainRequired ?? false,
    requestedByRunId: input.requestedByRunId ?? null,
  };
  await writeJsonFileAtomic(resolveHotRestartIntentPath(input.homeDir), intent);
  return intent;
}

export async function writeHotRestartShutdownSnapshot(input: {
  intent: HotRestartIntent;
  signal: "SIGINT" | "SIGTERM";
  activeRuns: HotRestartIntentRun[];
  capturedAt?: Date;
  homeDir?: string;
}) {
  const updated: HotRestartIntent = {
    ...input.intent,
    shutdownSnapshot: {
      capturedAt: (input.capturedAt ?? new Date()).toISOString(),
      signal: input.signal,
      activeRuns: input.activeRuns,
    },
  };
  await writeJsonFileAtomic(resolveHotRestartIntentPath(input.homeDir), updated);
  return updated;
}

export async function writeHotRestartReport(report: HotRestartReport, homeDir?: string) {
  await writeJsonFileAtomic(resolveHotRestartReportPath(homeDir), report);
  return report;
}

export async function removeHotRestartIntent(homeDir?: string) {
  try {
    await fs.unlink(resolveHotRestartIntentPath(homeDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function shouldHonorHotRestartIntentForProcess(
  intent: HotRestartIntent,
  pid = process.pid,
) {
  return !intent.drainRequired && intent.previousServerPid === pid;
}
