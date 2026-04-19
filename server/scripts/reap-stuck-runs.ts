// One-shot hotfix script for GEA-857 — recovers heartbeat runs stuck in
// `running` status with no liveness signal. Delegates the actual reap to
// `heartbeatService.reapOrphanedRuns({ staleThresholdMs })`, which is the
// same primitive the periodic sweeper uses (and which calls
// `releaseIssueExecutionAndPromote` so any deferred wakeups waiting on the
// stuck run's execution lock get promoted instead of stranded).
//
// THE 30-MINUTE THRESHOLD IS DELIBERATELY BLUNT and only suitable for a one-off
// manual intervention. Do NOT reuse this number as a generic watchdog default —
// the structural fix in `heartbeatService.reapOrphanedRuns` uses a per-agent,
// interval-aware timeout (`max(agent.heartbeatIntervalSec * 2, 600s)`) for
// `process_detached` runs.
//
// Usage:
//   pnpm --filter @paperclipai/server tsx scripts/reap-stuck-runs.ts \
//     [--apply] [--threshold-minutes 30] [--config /path/to/config.json]
//
// Default mode: dry-run (prints affected runs without changing the DB).
// Pass `--apply` to perform the writes.

import { and, eq, isNull, lt } from "drizzle-orm";
import {
  agents,
  createDb,
  heartbeatRuns,
} from "@paperclipai/db";
import { loadConfig } from "../src/config.js";
import { heartbeatService } from "../src/services/heartbeat.js";

type Db = ReturnType<typeof createDb>;
type StuckRunRow = {
  runId: string;
  agentId: string;
  agentName: string | null;
  startedAt: Date | null;
  updatedAt: Date | null;
  errorCode: string | null;
};

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
      agentId: heartbeatRuns.agentId,
      agentName: agents.name,
      startedAt: heartbeatRuns.startedAt,
      updatedAt: heartbeatRuns.updatedAt,
      errorCode: heartbeatRuns.errorCode,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
    .where(
      and(
        eq(heartbeatRuns.status, "running"),
        isNull(heartbeatRuns.finishedAt),
        lt(heartbeatRuns.updatedAt, threshold),
      ),
    );
  return rows;
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
    const thresholdMs = thresholdMinutes * 60_000;
    const threshold = new Date(now.getTime() - thresholdMs);

    process.stdout.write(
      `[reap-stuck-runs] mode=${apply ? "APPLY" : "dry-run"} threshold=${thresholdMinutes}m ` +
        `(runs whose updatedAt is older than ${threshold.toISOString()})\n`,
    );

    const stuck = await findStuckRuns(db, threshold);
    process.stdout.write(`[reap-stuck-runs] preview: ${stuck.length} candidate run(s)\n`);
    for (const run of stuck) {
      process.stdout.write(
        `  - run=${run.runId} agent=${run.agentName ?? run.agentId} ` +
          `startedAt=${run.startedAt?.toISOString() ?? "null"} ` +
          `updatedAt=${run.updatedAt?.toISOString() ?? "null"} ` +
          `errorCode=${run.errorCode ?? "null"}\n`,
      );
    }

    if (!apply) {
      process.stdout.write("[reap-stuck-runs] dry-run only — pass --apply to write changes\n");
      return;
    }

    // Delegate to the canonical primitive. It applies its own per-error-code
    // logic (process_detached → max(intervalSec*2, 600s); process_lost path
    // for runs with no detached marker) AND calls releaseIssueExecutionAndPromote
    // so deferred wakeups don't get stranded.
    const heartbeat = heartbeatService(db);
    const result = await heartbeat.reapOrphanedRuns({ staleThresholdMs: thresholdMs });
    process.stdout.write(
      `[reap-stuck-runs] done — reaped=${result.reaped} runIds=${JSON.stringify(result.runIds)}\n`,
    );
  } finally {
    await closableDb.$client?.end?.({ timeout: 5 }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
