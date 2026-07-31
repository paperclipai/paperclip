import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolvePaperclipHomeDir } from "../home-paths.js";

export const HOT_RESTART_INTENT_FILENAME = "hot-restart-intent.json";
export const HOT_RESTART_REPORT_FILENAME = "hot-restart-report.json";
export const EMBEDDED_POSTGRES_HANDOFF_FILENAME = "embedded-postgres-handoff.json";

const EMBEDDED_POSTGRES_HANDOFF_TTL_MS = 10 * 60 * 1_000;

export type EmbeddedPostgresProcessIdentity = {
  pid: number;
  startedAtEpochSeconds: number;
  dataDir: string;
  port: number;
};

export type EmbeddedPostgresHandoff = {
  version: 1;
  transferToken: string;
  createdAt: string;
  expiresAt: string;
  hotRestartRequestedAt: string;
  shutdownSnapshotCapturedAt: string;
  predecessorServerPid: number;
  predecessorServerStartedAtEpochMs: number;
  postgres: EmbeddedPostgresProcessIdentity;
};

export type EmbeddedPostgresHandoffClaim = EmbeddedPostgresHandoff & {
  replacementServerPid: number;
};

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

export function resolveEmbeddedPostgresHandoffPath(homeDir?: string) {
  return resolveHotRestartPath(EMBEDDED_POSTGRES_HANDOFF_FILENAME, homeDir);
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

function samePath(left: string, right: string) {
  const normalize = (value: string) => {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function samePostgresIdentity(
  left: EmbeddedPostgresProcessIdentity,
  right: EmbeddedPostgresProcessIdentity,
) {
  return left.pid === right.pid
    && left.startedAtEpochSeconds === right.startedAtEpochSeconds
    && left.port === right.port
    && samePath(left.dataDir, right.dataDir);
}

function parseEmbeddedPostgresProcessIdentity(
  value: unknown,
): EmbeddedPostgresProcessIdentity | null {
  if (!isRecord(value)) return null;
  const pid = asNumber(value.pid);
  const startedAtEpochSeconds = asNumber(value.startedAtEpochSeconds);
  const dataDir = asString(value.dataDir);
  const port = asNumber(value.port);
  if (!pid || !startedAtEpochSeconds || !dataDir || !port) return null;
  return { pid, startedAtEpochSeconds, dataDir, port };
}

function parseEmbeddedPostgresHandoff(value: unknown): EmbeddedPostgresHandoff | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const transferToken = asString(value.transferToken);
  const createdAt = asString(value.createdAt);
  const expiresAt = asString(value.expiresAt);
  const hotRestartRequestedAt = asString(value.hotRestartRequestedAt);
  const shutdownSnapshotCapturedAt = asString(value.shutdownSnapshotCapturedAt);
  const predecessorServerPid = asNumber(value.predecessorServerPid);
  const predecessorServerStartedAtEpochMs = asNumber(value.predecessorServerStartedAtEpochMs);
  const postgres = parseEmbeddedPostgresProcessIdentity(value.postgres);
  if (
    !transferToken
    || !createdAt
    || !expiresAt
    || !hotRestartRequestedAt
    || !shutdownSnapshotCapturedAt
    || !predecessorServerPid
    || !predecessorServerStartedAtEpochMs
    || !postgres
    || !Number.isFinite(Date.parse(createdAt))
    || !Number.isFinite(Date.parse(expiresAt))
    || !Number.isFinite(Date.parse(shutdownSnapshotCapturedAt))
  ) {
    return null;
  }
  return {
    version: 1,
    transferToken,
    createdAt,
    expiresAt,
    hotRestartRequestedAt,
    shutdownSnapshotCapturedAt,
    predecessorServerPid,
    predecessorServerStartedAtEpochMs,
    postgres,
  };
}

export async function readEmbeddedPostgresProcessIdentity(
  dataDir: string,
): Promise<EmbeddedPostgresProcessIdentity | null> {
  try {
    const canonicalDataDir = await fs.realpath(dataDir);
    const raw = await fs.readFile(path.join(canonicalDataDir, "postmaster.pid"), "utf8");
    const lines = raw.split(/\r?\n/);
    const pid = asNumber(Number(lines[0]?.trim()));
    const pidDataDir = asString(lines[1]?.trim());
    const startedAtEpochSeconds = asNumber(Number(lines[2]?.trim()));
    const port = asNumber(Number(lines[3]?.trim()));
    if (!pid || !pidDataDir || !startedAtEpochSeconds || !port) return null;
    const canonicalPidDataDir = await fs.realpath(pidDataDir);
    if (!samePath(canonicalDataDir, canonicalPidDataDir)) return null;
    return { pid, startedAtEpochSeconds, dataDir: canonicalDataDir, port };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeEmbeddedPostgresHandoff(input: {
  hotRestartRequestedAt: string;
  shutdownSnapshotCapturedAt: string;
  predecessorServerPid: number;
  predecessorServerStartedAtEpochMs: number;
  postgres: EmbeddedPostgresProcessIdentity;
  now?: Date;
  homeDir?: string;
}) {
  const now = input.now ?? new Date();
  const handoff: EmbeddedPostgresHandoff = {
    version: 1,
    transferToken: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EMBEDDED_POSTGRES_HANDOFF_TTL_MS).toISOString(),
    hotRestartRequestedAt: input.hotRestartRequestedAt,
    shutdownSnapshotCapturedAt: input.shutdownSnapshotCapturedAt,
    predecessorServerPid: input.predecessorServerPid,
    predecessorServerStartedAtEpochMs: input.predecessorServerStartedAtEpochMs,
    postgres: input.postgres,
  };
  await writeJsonFileAtomic(resolveEmbeddedPostgresHandoffPath(input.homeDir), handoff);
  return handoff;
}

export async function claimEmbeddedPostgresHandoff(input: {
  expectedHotRestartRequestedAt: string;
  expectedShutdownSnapshotCapturedAt: string;
  expectedPredecessorServerPid: number;
  expectedPostgres: EmbeddedPostgresProcessIdentity;
  replacementServerPid?: number;
  isProcessAlive?: (pid: number) => boolean;
  now?: Date;
  homeDir?: string;
}): Promise<EmbeddedPostgresHandoffClaim | null> {
  const handoffPath = resolveEmbeddedPostgresHandoffPath(input.homeDir);
  let handoff: EmbeddedPostgresHandoff | null;
  try {
    handoff = parseEmbeddedPostgresHandoff(JSON.parse(await fs.readFile(handoffPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!handoff) return null;

  const now = input.now ?? new Date();
  if (Date.parse(handoff.expiresAt) <= now.getTime()) {
    const expiredPath = `${handoffPath}.${handoff.transferToken}.expired`;
    try {
      await fs.rename(handoffPath, expiredPath);
      await fs.rm(expiredPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return null;
  }
  if (
    handoff.hotRestartRequestedAt !== input.expectedHotRestartRequestedAt
    || handoff.shutdownSnapshotCapturedAt !== input.expectedShutdownSnapshotCapturedAt
    || handoff.predecessorServerPid !== input.expectedPredecessorServerPid
    || !samePostgresIdentity(handoff.postgres, input.expectedPostgres)
  ) {
    return null;
  }

  const isProcessAlive = input.isProcessAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  });
  if (isProcessAlive(handoff.predecessorServerPid)) return null;

  const replacementServerPid = input.replacementServerPid ?? process.pid;
  const claimedPath = `${handoffPath}.${handoff.transferToken}.${replacementServerPid}.claimed`;
  try {
    await fs.rename(handoffPath, claimedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  await fs.rm(claimedPath, { force: true });
  return { ...handoff, replacementServerPid };
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
