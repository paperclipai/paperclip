import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolvePaperclipHomeDir,
  resolvePaperclipInstanceId,
  resolvePaperclipInstanceRoot,
} from "../home-paths.js";

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
const HOT_RESTART_LOCK_SUFFIX = ".lock";
const HOT_RESTART_LOCK_STALE_MS = 30_000;
const HOT_RESTART_LOCK_TIMEOUT_MS = 10_000;

type ProcessCommandRunner = (command: string, args: string[]) => Promise<string>;
type ProcessStatReader = (target: string) => Promise<{ ctimeMs: number }>;

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
  previousServerIdentity?: string | null;
  previousServerStartedAt?: string | null;
  previousServerVersion: string | null;
  drainRequired: boolean;
  requestedByRunId: string | null;
  preflightActiveRunIds: string[];
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
  return path.join(resolvePaperclipInstanceRoot({ homeDir }), filename);
}

function resolveLegacyHotRestartPath(filename: string, homeDir?: string) {
  return path.join(resolvePaperclipHomeDir(homeDir), filename);
}

export function resolveHotRestartIntentPath(homeDir?: string) {
  return resolveHotRestartPath(HOT_RESTART_INTENT_FILENAME, homeDir);
}

export function resolveLegacyHotRestartIntentPath(homeDir?: string) {
  return resolveLegacyHotRestartPath(HOT_RESTART_INTENT_FILENAME, homeDir);
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

async function writeJsonFileExclusiveAtomic(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await fs.link(tempPath, filePath);
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
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

function asDateString(value: unknown): string | null {
  const candidate = asString(value);
  if (!candidate) return null;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(asString).filter((entry): entry is string => entry !== null))];
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

function runProcessCommand(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: 1_500,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

export async function readProcessStartedAt(
  pid: number,
  options: {
    platform?: NodeJS.Platform;
    stat?: ProcessStatReader;
    runCommand?: ProcessCommandRunner;
  } = {},
) {
  const platform = options.platform ?? process.platform;
  const stat = options.stat ?? fs.stat;
  const runCommand = options.runCommand ?? runProcessCommand;

  if (platform === "linux") {
    const processStat = await stat(`/proc/${pid}`);
    return new Date(processStat.ctimeMs).toISOString();
  }

  if (["darwin", "freebsd", "openbsd", "aix", "sunos"].includes(platform)) {
    const stdout = await runCommand("ps", ["-o", "lstart=", "-p", String(pid)]);
    const startedAt = asDateString(stdout.trim());
    if (!startedAt) {
      throw new Error(`Could not parse ${platform} process start time for PID ${pid}`);
    }
    return startedAt;
  }

  if (platform === "win32") {
    const script = [
      `$process = Get-Process -Id ${pid} -ErrorAction Stop`,
      "$process.StartTime.ToUniversalTime().ToString('o')",
    ].join("; ");
    let stdout: string;
    try {
      stdout = await runCommand("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);
    } catch {
      stdout = await runCommand("pwsh.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ]);
    }
    const startedAt = asDateString(stdout.trim());
    if (!startedAt) {
      throw new Error(`Could not parse Windows process start time for PID ${pid}`);
    }
    return startedAt;
  }

  return null;
}

export function isObservedHotRestartTargetAlive(
  intent: HotRestartIntent,
  observation: {
    alive: boolean;
    startedAt: string | null;
    replacement?: Pick<
      HotRestartIntent,
      "previousServerPid" | "previousServerIdentity" | "previousServerStartedAt"
    >;
  },
) {
  if (!observation.alive) return false;

  if (observation.replacement?.previousServerPid === intent.previousServerPid) {
    if (
      observation.replacement.previousServerIdentity
      && intent.previousServerIdentity
    ) {
      return observation.replacement.previousServerIdentity
        === intent.previousServerIdentity;
    }

    if (
      observation.replacement.previousServerIdentity
      && !intent.previousServerIdentity
    ) {
      const replacementStartedAt = Date.parse(
        observation.replacement.previousServerIdentity,
      );
      const requestedAt = Date.parse(intent.requestedAt);
      if (Number.isFinite(replacementStartedAt) && Number.isFinite(requestedAt)) {
        // The health endpoint's processStartedAt value is also the current
        // server boot identity. If that process started after an older marker
        // was requested, the shared numeric PID was necessarily recycled.
        return replacementStartedAt <= requestedAt;
      }
    }

    if (!intent.previousServerIdentity) {
      const replacementStartedAt = observation.replacement.previousServerStartedAt
        ? Date.parse(observation.replacement.previousServerStartedAt)
        : Number.NaN;
      const requestedAt = Date.parse(intent.requestedAt);
      if (Number.isFinite(replacementStartedAt) && Number.isFinite(requestedAt)) {
        return replacementStartedAt <= requestedAt;
      }
    }
  }

  const observedStartedAt = observation.startedAt
    ? Date.parse(observation.startedAt)
    : Number.NaN;
  const recordedStartedAt = intent.previousServerStartedAt
    ? Date.parse(intent.previousServerStartedAt)
    : Number.NaN;
  if (Number.isFinite(observedStartedAt) && Number.isFinite(recordedStartedAt)) {
    return observedStartedAt === recordedStartedAt;
  }

  const requestedAt = Date.parse(intent.requestedAt);
  if (Number.isFinite(observedStartedAt) && Number.isFinite(requestedAt)) {
    // Older markers have no recorded process start. A process that started
    // after the request necessarily reused the marker's numeric PID.
    return observedStartedAt <= requestedAt;
  }

  throw new Error(
    `Cannot establish process identity for live hot-restart target PID ${intent.previousServerPid}`,
  );
}

async function isOriginalServerProcessAlive(
  intent: HotRestartIntent,
  replacement: HotRestartIntent,
) {
  const alive = isProcessAlive(intent.previousServerPid);
  const startedAt = alive
    ? await readProcessStartedAt(intent.previousServerPid)
    : null;
  return isObservedHotRestartTargetAlive(intent, {
    alive,
    startedAt,
    replacement,
  });
}

async function removeStaleHotRestartLock(lockDir: string) {
  let shouldRemove = false;
  try {
    const owner = JSON.parse(
      await fs.readFile(path.join(lockDir, "owner.json"), "utf8"),
    ) as { pid?: unknown; createdAt?: unknown };
    const pid = typeof owner.pid === "number" ? owner.pid : 0;
    const createdAt = typeof owner.createdAt === "string"
      ? Date.parse(owner.createdAt)
      : Number.NaN;
    const ageMs = Number.isFinite(createdAt)
      ? Date.now() - createdAt
      : HOT_RESTART_LOCK_STALE_MS + 1;
    shouldRemove = !isProcessAlive(pid) || ageMs > HOT_RESTART_LOCK_STALE_MS;
  } catch {
    const stat = await fs.stat(lockDir).catch(() => null);
    shouldRemove = !stat
      || Date.now() - stat.mtimeMs > HOT_RESTART_LOCK_STALE_MS;
  }
  if (!shouldRemove) return false;
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function acquireHotRestartPathLock(filePath: string) {
  const lockDir = `${filePath}${HOT_RESTART_LOCK_SUFFIX}`;
  const deadline = Date.now() + HOT_RESTART_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      await fs.mkdir(lockDir);
      try {
        await fs.writeFile(
          path.join(lockDir, "owner.json"),
          `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
          "utf8",
        );
      } catch (error) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await removeStaleHotRestartLock(lockDir)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for hot-restart compatibility lock at ${lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function withHotRestartPathLock<T>(filePath: string, operation: () => Promise<T>) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const release = await acquireHotRestartPathLock(filePath);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function isSameHotRestartRequest(left: HotRestartIntent, right: HotRestartIntent) {
  return left.requestedAt === right.requestedAt
    && left.previousServerPid === right.previousServerPid
    && left.drainRequired === right.drainRequired
    && left.requestedByRunId === right.requestedByRunId;
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
    previousServerIdentity: asString(value.previousServerIdentity),
    previousServerStartedAt: asDateString(value.previousServerStartedAt),
    previousServerVersion: asString(value.previousServerVersion),
    drainRequired: asBoolean(value.drainRequired),
    requestedByRunId: asString(value.requestedByRunId),
    preflightActiveRunIds: asStringArray(value.preflightActiveRunIds),
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

async function readHotRestartIntentAtPath(filePath: string) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseHotRestartIntent(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function readHotRestartIntent(homeDir?: string) {
  const instanceIntent = await readHotRestartIntentAtPath(resolveHotRestartIntentPath(homeDir));
  let legacyIntent: HotRestartIntent | null;
  try {
    legacyIntent = await readHotRestartIntentAtPath(resolveLegacyHotRestartIntentPath(homeDir));
  } catch (error) {
    if (instanceIntent) return instanceIntent;
    throw error;
  }

  if (!instanceIntent) {
    // The home-root marker predates instances. Only the default instance may
    // consume it without an instance-root request to correlate against.
    return resolvePaperclipInstanceId() === "default" ? legacyIntent : null;
  }
  if (!legacyIntent || !isSameHotRestartRequest(instanceIntent, legacyIntent)) {
    return instanceIntent;
  }

  // A pre-instance server rewrites only the legacy marker when it captures
  // its shutdown snapshot. Preserve the instance-scoped request fields while
  // importing that snapshot only after the immutable request identity matches.
  return legacyIntent.shutdownSnapshot
    ? { ...instanceIntent, shutdownSnapshot: legacyIntent.shutdownSnapshot }
    : instanceIntent;
}

export function findMissingHotRestartSnapshotRunIds(intent: HotRestartIntent) {
  const snapshotRunIds = new Set(intent.shutdownSnapshot?.activeRuns.map((run) => run.runId) ?? []);
  return intent.preflightActiveRunIds.filter((runId) => !snapshotRunIds.has(runId));
}

export async function writeHotRestartIntent(input: {
  previousServerPid: number;
  previousServerIdentity?: string | null;
  previousServerStartedAt?: string | null;
  previousServerVersion?: string | null;
  drainRequired?: boolean;
  requestedByRunId?: string | null;
  preflightActiveRunIds?: string[];
  requestedAt?: Date;
  homeDir?: string;
}) {
  const previousServerStartedAt = input.previousServerStartedAt === undefined
    ? await readProcessStartedAt(input.previousServerPid)
    : asDateString(input.previousServerStartedAt);
  const previousServerIdentity = asString(input.previousServerIdentity);
  if (!previousServerIdentity && !previousServerStartedAt) {
    throw new Error(
      `Cannot create hot-restart intent for PID ${input.previousServerPid}: `
      + "server boot identity and operating-system process start time are unavailable",
    );
  }
  const intent: HotRestartIntent = {
    version: 1,
    requestedAt: (input.requestedAt ?? new Date()).toISOString(),
    previousServerPid: input.previousServerPid,
    previousServerIdentity,
    previousServerStartedAt,
    previousServerVersion: input.previousServerVersion ?? null,
    drainRequired: input.drainRequired ?? false,
    requestedByRunId: input.requestedByRunId ?? null,
    preflightActiveRunIds: asStringArray(input.preflightActiveRunIds),
  };
  const instancePath = resolveHotRestartIntentPath(input.homeDir);
  const legacyPath = resolveLegacyHotRestartIntentPath(input.homeDir);
  // The legacy location is shared by every instance under PAPERCLIP_HOME.
  // Claim it without replacement so concurrent staged restarts fail closed
  // instead of making the first old server consume another instance's PID.
  await withHotRestartPathLock(legacyPath, () => claimLegacyHotRestartIntent(legacyPath, intent));
  try {
    await withHotRestartPathLock(instancePath, () => writeJsonFileAtomic(instancePath, intent));
  } catch (error) {
    await withHotRestartPathLock(
      legacyPath,
      () => removeMatchingHotRestartIntent(legacyPath, intent),
    ).catch(() => undefined);
    throw error;
  }
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
  const instancePath = resolveHotRestartIntentPath(input.homeDir);
  await withHotRestartPathLock(instancePath, () => writeJsonFileAtomic(instancePath, updated));
  const legacyPath = resolveLegacyHotRestartIntentPath(input.homeDir);
  await withHotRestartPathLock(legacyPath, async () => {
    const legacyIntent = await readHotRestartIntentAtPath(legacyPath).catch(() => null);
    if (legacyIntent && isSameHotRestartRequest(legacyIntent, input.intent)) {
      await writeJsonFileAtomic(legacyPath, updated);
    }
  });
  return updated;
}

export async function writeHotRestartReport(report: HotRestartReport, homeDir?: string) {
  await writeJsonFileAtomic(resolveHotRestartReportPath(homeDir), report);
  return report;
}

async function removeMatchingHotRestartIntent(filePath: string, expected?: HotRestartIntent) {
  try {
    if (expected) {
      const current = await readHotRestartIntentAtPath(filePath);
      if (!current || !isSameHotRestartRequest(current, expected)) return;
    }
    await fs.unlink(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function claimLegacyHotRestartIntent(filePath: string, intent: HotRestartIntent) {
  try {
    await writeJsonFileExclusiveAtomic(filePath, intent);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    const existing = await readHotRestartIntentAtPath(filePath).catch(() => null);
    if (
      !existing
      || await isOriginalServerProcessAlive(existing, intent)
    ) {
      throw error;
    }

    // An interrupted restart can leave the shared claim behind after its
    // target server exits. Remove only that exact abandoned request, then
    // compete normally for a fresh exclusive claim.
    await removeMatchingHotRestartIntent(filePath, existing);
    await writeJsonFileExclusiveAtomic(filePath, intent);
  }
}

export async function removeHotRestartIntent(homeDir?: string, expected?: HotRestartIntent) {
  const instancePath = resolveHotRestartIntentPath(homeDir);
  await withHotRestartPathLock(
    instancePath,
    () => removeMatchingHotRestartIntent(instancePath, expected),
  );
  const legacyPath = resolveLegacyHotRestartIntentPath(homeDir);
  await withHotRestartPathLock(
    legacyPath,
    () => removeMatchingHotRestartIntent(legacyPath, expected),
  );
}

export function shouldHonorHotRestartIntentForProcess(
  intent: HotRestartIntent,
  pid = process.pid,
) {
  return !intent.drainRequired && intent.previousServerPid === pid;
}
