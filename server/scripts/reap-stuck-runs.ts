// One-shot hotfix script for GEA-857 — recovers heartbeat runs stuck in
// `running` status with no liveness signal. Sets them to `failed` and releases
// the issue execution lock so the scheduler can pick them up again.
//
// THE 30-MINUTE THRESHOLD IS DELIBERATELY BLUNT and only suitable for a one-off
// manual intervention. Do NOT reuse this number as a generic watchdog default —
// the structural fix in `heartbeatService.reapOrphanedRuns` uses a per-agent,
// interval-aware timeout (`max(agent.heartbeatIntervalSec * 2, 600s)`).
//
// Usage:
//   pnpm --filter @paperclipai/server tsx scripts/reap-stuck-runs.ts \
//     [--apply] [--threshold-minutes 30] [--config /path/to/config.json]
//
// Default mode: dry-run (prints affected runs without changing the DB).
// Pass `--apply` to perform the writes.

import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { loadConfig } from "../src/config.js";

type Db = ReturnType<typeof createDb>;
type StuckRunRow = {
  runId: string;
  companyId: string;
  agentId: string;
  agentName: string | null;
  startedAt: Date | null;
  errorCode: string | null;
  wakeupRequestId: string | null;
  contextSnapshot: Record<string, unknown> | null;
};

const HOTFIX_ERROR_MESSAGE = "stuck-run recovery (manual hotfix GEA-857)";
const HOTFIX_ERROR_CODE = "process_stuck_hotfix";

function readArg(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  return process.argv[index + 1] ?? null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function resolveDatabaseUrl(): string {
  if (process.env.PAPERCLIP_CONFIG === undefined) {
    const overrideConfig = readArg("--config");
    if (overrideConfig) process.env.PAPERCLIP_CONFIG = overrideConfig;
  }
  const config = loadConfig();
  if (config.databaseUrl) return config.databaseUrl;
  if (config.databaseMode === "embedded-postgres") {
    return `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  }
  throw new Error("Could not resolve database URL: set DATABASE_URL or configure database in config.json");
}

async function findStuckRuns(db: Db, threshold: Date): Promise<StuckRunRow[]> {
  const rows = await db
    .select({
      runId: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      startedAt: heartbeatRuns.startedAt,
      errorCode: heartbeatRuns.errorCode,
      wakeupRequestId: heartbeatRuns.wakeupRequestId,
      contextSnapshot: heartbeatRuns.contextSnapshot,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        isNull(heartbeatRuns.finishedAt),
        lt(heartbeatRuns.startedAt, threshold),
      ),
    );
  return rows;
}

async function reapRun(db: Db, run: StuckRunRow, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(heartbeatRuns)
      .set({
        status: "failed",
        error: HOTFIX_ERROR_MESSAGE,
        errorCode: HOTFIX_ERROR_CODE,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(heartbeatRuns.id, run.runId), eq(heartbeatRuns.status, "running")));

    if (run.wakeupRequestId) {
      await tx
        .update(agentWakeupRequests)
        .set({
          status: "failed",
          finishedAt: now,
          error: HOTFIX_ERROR_MESSAGE,
          updatedAt: now,
        })
        .where(eq(agentWakeupRequests.id, run.wakeupRequestId));
    }

    // Release the issue execution lock for any issue holding this run.
    // Mirrors `releaseIssueExecutionAndPromote` minus deferred-wakeup promotion;
    // the next scheduler tick will pick up deferred wakeups normally.
    const contextIssueId =
      typeof run.contextSnapshot === "object" &&
      run.contextSnapshot !== null &&
      typeof (run.contextSnapshot as Record<string, unknown>).issueId === "string"
        ? ((run.contextSnapshot as Record<string, unknown>).issueId as string)
        : null;

    await tx
      .update(issues)
      .set({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(issues.companyId, run.companyId),
          eq(issues.executionRunId, run.runId),
          contextIssueId ? eq(issues.id, contextIssueId) : sql`true`,
        ),
      );
  });
}

async function main() {
  const apply = hasFlag("--apply");
  const thresholdMinutesArg = readArg("--threshold-minutes");
  const thresholdMinutes = thresholdMinutesArg ? Number(thresholdMinutesArg) : 30;
  if (!Number.isFinite(thresholdMinutes) || thresholdMinutes <= 0) {
    throw new Error(`Invalid --threshold-minutes: ${thresholdMinutesArg}`);
  }

  const dbUrl = resolveDatabaseUrl();
  const db = createDb(dbUrl);
  const closableDb = db as typeof db & {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  };

  try {
    const now = new Date();
    const threshold = new Date(now.getTime() - thresholdMinutes * 60_000);

    process.stdout.write(
      `[reap-stuck-runs] mode=${apply ? "APPLY" : "dry-run"} threshold=${thresholdMinutes}m ` +
        `(runs started before ${threshold.toISOString()})\n`,
    );

    const stuck = await findStuckRuns(db, threshold);
    process.stdout.write(`[reap-stuck-runs] found ${stuck.length} stuck run(s)\n`);
    for (const run of stuck) {
      process.stdout.write(
        `  - run=${run.runId} agent=${run.agentName ?? run.agentId} ` +
          `startedAt=${run.startedAt?.toISOString() ?? "null"} ` +
          `errorCode=${run.errorCode ?? "null"}\n`,
      );
    }

    if (!apply) {
      process.stdout.write("[reap-stuck-runs] dry-run only — pass --apply to write changes\n");
      return;
    }

    let reaped = 0;
    let failed = 0;
    for (const run of stuck) {
      try {
        await reapRun(db, run, now);
        reaped += 1;
        process.stdout.write(`[reap-stuck-runs] reaped ${run.runId}\n`);
      } catch (err) {
        failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[reap-stuck-runs] FAILED to reap ${run.runId}: ${msg}\n`);
      }
    }
    process.stdout.write(`[reap-stuck-runs] done — reaped=${reaped} failed=${failed}\n`);
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
