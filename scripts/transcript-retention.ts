#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray, isNotNull, lt, not, or, sql } from "../packages/db/node_modules/drizzle-orm/index.js";
import {
  activityLog,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueTreeHoldMembers,
  issueTreeHolds,
} from "../packages/db/src/index.ts";
import { resolveMigrationConnection } from "../packages/db/src/migration-runtime.ts";

const RETENTION_DAYS = 7;
const TERMINAL_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
const LIVE_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_STATUSES);
const LIVE_STATUS_SET = new Set<string>(LIVE_STATUSES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APPLY = process.argv.includes("--apply");
const RESTORE_INDEX = process.argv.indexOf("--restore-permissions");

type ModeRecord = { path: string; mode: number; targetMode?: number };
type RunRow = {
  id: string;
  companyId: string;
  status: string;
  finishedAt: Date | null;
  logRef: string | null;
  hasResultJson: boolean;
  hasStdoutExcerpt: boolean;
  hasStderrExcerpt: boolean;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  externalRunId: string | null;
  contextIssueId: string | null;
};
type SessionRunRow = {
  id: string;
  status: string;
  finishedAt: Date | null;
  sessionIdBefore: string | null;
  sessionIdAfter: string | null;
  externalRunId: string | null;
};

function modeOf(mode: number) {
  return mode & 0o777;
}

function sessionIds(run: Pick<RunRow, "sessionIdBefore" | "sessionIdAfter" | "externalRunId">) {
  return [run.sessionIdBefore, run.sessionIdAfter, run.externalRunId].filter(
    (value): value is string => typeof value === "string" && UUID.test(value),
  );
}

function oldTerminalPredicate(cutoff: Date) {
  return and(
    inArray(heartbeatRuns.status, [...TERMINAL_STATUSES]),
    isNotNull(heartbeatRuns.finishedAt),
    lt(heartbeatRuns.finishedAt, cutoff),
  )!;
}

function isWithin(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  }
  return files;
}

async function inventory(root: string, suffix?: string) {
  const files = (await walkFiles(root)).filter((file) => !suffix || file.endsWith(suffix));
  return summarizeFiles(files);
}

async function summarizeFiles(files: string[]) {
  let bytes = 0;
  let nonOwnerOnly = 0;
  for (const file of files) {
    const stat = await fs.stat(file);
    bytes += stat.size;
    if (modeOf(stat.mode) !== 0o600) nonOwnerOnly++;
  }
  return { files, count: files.length, bytes, nonOwnerOnly };
}

async function recordModeChange(candidate: string, desiredMode: number, rollback: ModeRecord[]) {
  const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat || stat.isSymbolicLink()) return;
  const currentMode = modeOf(stat.mode);
  if (currentMode === desiredMode) return;
  rollback.push({ path: candidate, mode: currentMode, targetMode: desiredMode });
}

async function hardenTree(root: string, rollback: ModeRecord[]) {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat || stat.isSymbolicLink()) return;
  await recordModeChange(root, 0o700, rollback);
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await recordModeChange(candidate, 0o700, rollback);
        pending.push(candidate);
      } else if (entry.isFile()) {
        await recordModeChange(candidate, 0o600, rollback);
      }
    }
  }
}

async function hardenAncestors(home: string, root: string, rollback: ModeRecord[]) {
  if (!isWithin(home, root)) throw new Error(`Refusing to chmod path outside home: ${root}`);
  let current = path.resolve(root);
  const paths: string[] = [];
  while (current !== path.resolve(home)) {
    paths.push(current);
    current = path.dirname(current);
  }
  for (const candidate of paths.reverse()) {
    await recordModeChange(candidate, 0o700, rollback);
  }
}

async function applyModePlan(rollback: ModeRecord[]) {
  for (const entry of rollback) {
    if (entry.targetMode !== 0o600 && entry.targetMode !== 0o700) {
      throw new Error(`Invalid target mode for ${entry.path}`);
    }
    await fs.chmod(entry.path, entry.targetMode);
  }
}

async function writeRollbackState(retentionRoot: string, rollback: ModeRecord[], cutoff: Date) {
  await fs.mkdir(retentionRoot, { recursive: true, mode: 0o700 });
  await fs.chmod(retentionRoot, 0o700);
  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const target = path.join(retentionRoot, `permissions-rollback-${stamp}.json`);
  const temporary = `${target}.tmp`;
  await fs.writeFile(
    temporary,
    `${JSON.stringify({ version: 1, cutoff: cutoff.toISOString(), createdAt: new Date().toISOString(), entries: rollback }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.rename(temporary, target);
  return target;
}

async function restorePermissions(file: string) {
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { entries?: ModeRecord[] };
  if (!Array.isArray(parsed.entries)) throw new Error("Invalid permissions rollback file");
  const home = path.resolve(os.homedir());
  const realHome = await fs.realpath(home);
  let restored = 0;
  for (const entry of [...parsed.entries].reverse()) {
    if (
      !entry
      || typeof entry.path !== "string"
      || !Number.isInteger(entry.mode)
      || entry.mode < 0
    ) {
      throw new Error("Invalid permissions rollback entry");
    }
    const candidate = path.resolve(entry.path);
    if (!isWithin(home, candidate)) {
      throw new Error(`Refusing to restore permissions outside home: ${entry.path}`);
    }
    const stat = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to restore permissions through symbolic link: ${entry.path}`);
    }
    const realCandidate = await fs.realpath(candidate);
    if (!isWithin(realHome, realCandidate)) {
      throw new Error(`Refusing to restore permissions outside real home: ${entry.path}`);
    }
    await fs.chmod(candidate, modeOf(entry.mode));
    restored++;
  }
  console.log(JSON.stringify({ mode: "restore-permissions", rollbackFile: file, restored }));
}

async function probeServiceAccess(roots: string[]) {
  for (const root of roots) {
    const stat = await fs.stat(root).catch(() => null);
    if (!stat) continue;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`Service identity does not own ${root}`);
    }
    const probe = path.join(root, `.retention-access-probe-${process.pid}-${randomUUID()}`);
    await fs.writeFile(probe, "probe\n", { encoding: "utf8", mode: 0o600 });
    await fs.readFile(probe, "utf8");
    await fs.unlink(probe);
  }
}

async function removeApprovedFile(file: string, root: string, cutoffMs: number) {
  if (!isWithin(root, file)) throw new Error(`Refusing to delete path outside approved root: ${file}`);
  const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return { deleted: false, missing: true, bytes: 0 };
  if (stat.isSymbolicLink()) throw new Error(`Refusing to delete symbolic link: ${file}`);
  const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
  if (!isWithin(realRoot, realFile)) {
    throw new Error(`Refusing to delete path outside real approved root: ${file}`);
  }
  if (stat.mtimeMs >= cutoffMs) return { deleted: false, missing: false, bytes: 0 };
  await fs.unlink(file);
  return { deleted: true, missing: false, bytes: stat.size };
}

async function runsWithPersistedEventContent(
  db: ReturnType<typeof createDb>,
  runIds: string[],
) {
  const result = new Set<string>();
  for (let start = 0; start < runIds.length; start += 500) {
    const batch = runIds.slice(start, start + 500);
    const rows = await db
      .select({ runId: heartbeatRunEvents.runId })
      .from(heartbeatRunEvents)
      .where(
        and(
          inArray(heartbeatRunEvents.runId, batch),
          or(
            isNotNull(heartbeatRunEvents.message),
            isNotNull(heartbeatRunEvents.payload),
          ),
        ),
      );
    for (const row of rows) result.add(row.runId);
  }
  return result;
}

async function updateDatabase(
  db: ReturnType<typeof createDb>,
  runs: RunRow[],
  cutoff: Date,
  counts: Record<string, number>,
) {
  const ids = runs.map((run) => run.id);
  for (let start = 0; start < ids.length; start += 500) {
    const batch = ids.slice(start, start + 500);
    await db.transaction(async (tx) => {
      await tx
        .update(heartbeatRuns)
        .set({
          resultJson: null,
          stdoutExcerpt: null,
          stderrExcerpt: null,
          logStore: null,
          logRef: null,
          updatedAt: new Date(),
        })
        .where(inArray(heartbeatRuns.id, batch));
      await tx
        .update(heartbeatRunEvents)
        .set({ message: null, payload: null })
        .where(inArray(heartbeatRunEvents.runId, batch));
    });
  }

  const byCompany = new Map<string, number>();
  for (const run of runs) byCompany.set(run.companyId, (byCompany.get(run.companyId) ?? 0) + 1);
  for (const [companyId, scrubbedRuns] of byCompany) {
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "transcript_retention",
      action: "transcript_retention_sweep",
      entityType: "company",
      entityId: companyId,
      details: {
        cutoff: cutoff.toISOString(),
        retentionDays: RETENTION_DAYS,
        scrubbedRuns,
        ...counts,
        outcome: counts.failures > 0 ? "partial" : "succeeded",
      },
    });
  }
}

async function main() {
  if (RESTORE_INDEX >= 0) {
    const rollbackFile = process.argv[RESTORE_INDEX + 1];
    if (!rollbackFile) throw new Error("--restore-permissions requires a rollback file");
    await restorePermissions(rollbackFile);
    return;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1_000);
  const cutoffMs = cutoff.getTime();
  const home = os.homedir();
  const instanceRoot = path.resolve(
    process.env.PAPERCLIP_INSTANCE_ROOT ?? path.join(home, ".paperclip", "instances", "default"),
  );
  const runLogRoot = path.join(instanceRoot, "data", "run-logs");
  const backupRoot = path.join(instanceRoot, "data", "backups");
  const retentionRoot = path.join(instanceRoot, "data", "retention");
  const cursorProjectsRoot = path.join(home, ".cursor", "projects");

  const connection = await resolveMigrationConnection();
  const db = createDb(connection.connectionString);
  try {
    const oldTerminalWhere = oldTerminalPredicate(cutoff);
    const oldTerminalRuns = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        logRef: heartbeatRuns.logRef,
        hasResultJson: sql<boolean>`(${heartbeatRuns.resultJson} is not null)`.mapWith(Boolean),
        hasStdoutExcerpt: sql<boolean>`(${heartbeatRuns.stdoutExcerpt} is not null)`.mapWith(Boolean),
        hasStderrExcerpt: sql<boolean>`(${heartbeatRuns.stderrExcerpt} is not null)`.mapWith(Boolean),
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
        externalRunId: heartbeatRuns.externalRunId,
        contextIssueId: sql<string | null>`coalesce(${heartbeatRuns.contextSnapshot} ->> 'issueId', ${heartbeatRuns.contextSnapshot} ->> 'taskId')`,
      })
      .from(heartbeatRuns)
      .where(oldTerminalWhere) as RunRow[];
    const protectiveSessionRuns = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        finishedAt: heartbeatRuns.finishedAt,
        sessionIdBefore: heartbeatRuns.sessionIdBefore,
        sessionIdAfter: heartbeatRuns.sessionIdAfter,
        externalRunId: heartbeatRuns.externalRunId,
      })
      .from(heartbeatRuns)
      .where(not(oldTerminalWhere)) as SessionRunRow[];
    const activeHoldMembers = await db
      .select({ issueId: issueTreeHoldMembers.issueId })
      .from(issueTreeHoldMembers)
      .innerJoin(issueTreeHolds, eq(issueTreeHolds.id, issueTreeHoldMembers.holdId))
      .where(and(eq(issueTreeHolds.status, "active"), eq(issueTreeHoldMembers.skipped, false)));
    const heldIssueIds = new Set(activeHoldMembers.map((row) => row.issueId));
    const explicitHeldRunIds = new Set(
      (process.env.PAPERCLIP_TRANSCRIPT_RETENTION_HOLD_RUN_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );

    const active = protectiveSessionRuns.filter((run) => LIVE_STATUS_SET.has(run.status));
    const ambiguous = protectiveSessionRuns.filter(
      (run) => TERMINAL_STATUS_SET.has(run.status) && !run.finishedAt,
    );
    const held = oldTerminalRuns.filter(
      (run) => explicitHeldRunIds.has(run.id) || heldIssueIds.has(run.contextIssueId ?? ""),
    );
    const heldIds = new Set(held.map((run) => run.id));
    const unheldOldTerminal = oldTerminalRuns.filter((run) => !heldIds.has(run.id));
    const eventContentRunIds = await runsWithPersistedEventContent(
      db,
      unheldOldTerminal.map((run) => run.id),
    );

    const [runLogs, cursorTranscripts, backups] = await Promise.all([
      inventory(runLogRoot, ".ndjson"),
      inventory(cursorProjectsRoot, ".jsonl"),
      inventory(backupRoot),
    ]);
    const cursorTranscriptFiles = cursorTranscripts.files.filter((file) => {
      const relative = path.relative(cursorProjectsRoot, file).split(path.sep);
      return relative.length >= 4
        && relative.at(-3) === "agent-transcripts"
        && relative.at(-2) === path.basename(file, ".jsonl");
    });
    const cursorTranscriptInventory = await summarizeFiles(cursorTranscriptFiles);
    const availableCursorSessionIds = new Set(
      cursorTranscriptFiles.map((file) => path.basename(file, ".jsonl")),
    );
    const eligible = unheldOldTerminal.filter(
      (run) =>
        run.logRef !== null
        || run.hasResultJson
        || run.hasStdoutExcerpt
        || run.hasStderrExcerpt
        || eventContentRunIds.has(run.id)
        || sessionIds(run).some((sessionId) => availableCursorSessionIds.has(sessionId)),
    );
    const eligibleIds = new Set(eligible.map((run) => run.id));
    const protectedSessions = new Set([
      ...protectiveSessionRuns.flatMap(sessionIds),
      ...oldTerminalRuns.filter((run) => !eligibleIds.has(run.id)).flatMap(sessionIds),
    ]);
    const eligibleSessions = new Map<string, Set<string>>();
    for (const run of eligible) {
      for (const sessionId of sessionIds(run)) {
        if (protectedSessions.has(sessionId)) continue;
        const runIds = eligibleSessions.get(sessionId) ?? new Set<string>();
        runIds.add(run.id);
        eligibleSessions.set(sessionId, runIds);
      }
    }

    const report = {
      mode: APPLY ? "apply" : "dry-run",
      cutoff: cutoff.toISOString(),
      retentionDays: RETENTION_DAYS,
      eligibleRuns: eligible.length,
      excludedActiveRuns: active.length,
      excludedHeldRuns: held.length,
      excludedAmbiguousTerminalRuns: ambiguous.length,
      runLogs: { count: runLogs.count, bytes: runLogs.bytes, nonOwnerOnly: runLogs.nonOwnerOnly },
      cursorTranscripts: {
        count: cursorTranscriptInventory.count,
        bytes: cursorTranscriptInventory.bytes,
        nonOwnerOnly: cursorTranscriptInventory.nonOwnerOnly,
        approvedSessions: eligibleSessions.size,
      },
      backups: { count: backups.count, bytes: backups.bytes, nonOwnerOnly: backups.nonOwnerOnly },
    };
    if (!APPLY) {
      console.log(JSON.stringify(report));
      return;
    }

    const transcriptRoots = [runLogRoot, backupRoot];
    const cursorTranscriptRoots = new Set(
      cursorTranscriptFiles.map((file) => path.dirname(path.dirname(file))),
    );
    await probeServiceAccess([...transcriptRoots, ...cursorTranscriptRoots]);

    const rollback: ModeRecord[] = [];
    await hardenAncestors(home, runLogRoot, rollback);
    await hardenAncestors(home, backupRoot, rollback);
    await hardenTree(runLogRoot, rollback);
    await hardenTree(backupRoot, rollback);
    await hardenAncestors(home, cursorProjectsRoot, rollback);
    for (const root of cursorTranscriptRoots) {
      await hardenAncestors(home, root, rollback);
      await hardenTree(root, rollback);
    }
    const rollbackFile = await writeRollbackState(retentionRoot, rollback, cutoff);
    await applyModePlan(rollback);
    await probeServiceAccess([...transcriptRoots, ...cursorTranscriptRoots]);

    const failedRunIds = new Set<string>();
    let deletedRunLogs = 0;
    let deletedRunLogBytes = 0;
    for (const run of eligible) {
      if (!run.logRef) continue;
      const file = path.resolve(runLogRoot, run.logRef);
      try {
        const result = await removeApprovedFile(file, runLogRoot, cutoffMs);
        if (result.deleted) {
          deletedRunLogs++;
          deletedRunLogBytes += result.bytes;
        } else if (!result.missing) {
          failedRunIds.add(run.id);
        }
      } catch {
        failedRunIds.add(run.id);
      }
    }

    let deletedCursorTranscripts = 0;
    let deletedCursorBytes = 0;
    for (const file of cursorTranscriptFiles) {
      const sessionId = path.basename(file, ".jsonl");
      const associatedRunIds = eligibleSessions.get(sessionId);
      if (!associatedRunIds) continue;
      try {
        const result = await removeApprovedFile(file, cursorProjectsRoot, cutoffMs);
        if (result.deleted) {
          deletedCursorTranscripts++;
          deletedCursorBytes += result.bytes;
        } else if (!result.missing) {
          for (const runId of associatedRunIds) failedRunIds.add(runId);
        }
      } catch {
        for (const runId of associatedRunIds) failedRunIds.add(runId);
      }
    }

    const successfulRuns = eligible.filter((run) => !failedRunIds.has(run.id));
    const counts = {
      eligibleRuns: eligible.length,
      scrubbedRuns: successfulRuns.length,
      failures: failedRunIds.size,
      deletedRunLogs,
      deletedRunLogBytes,
      deletedCursorTranscripts,
      deletedCursorBytes,
      excludedActiveRuns: active.length,
      excludedHeldRuns: held.length,
      excludedAmbiguousTerminalRuns: ambiguous.length,
    };
    await updateDatabase(db, successfulRuns, cutoff, counts);
    console.log(JSON.stringify({ ...report, ...counts, rollbackFile }));
    if (failedRunIds.size > 0) process.exitCode = 1;
  } finally {
    await (
      db as unknown as { $client: { end(options?: { timeout?: number }): Promise<void> } }
    ).$client.end({ timeout: 1 });
    await connection.stop();
  }
}

main().then(
  () => {
    if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
  },
  (error) => {
    console.error(JSON.stringify({ outcome: "failed", error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  },
);
