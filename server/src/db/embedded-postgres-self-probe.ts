import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import type { EmbeddedPostgresSupervisor } from "./embedded-postgres-supervisor.js";

export const SELF_PROBE_INTERVAL_MS = 30_000;

export type EmbeddedPostgresSelfProbeLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export type EmbeddedPostgresSelfProbeDeps = {
  db: Db;
  supervisor: EmbeddedPostgresSupervisor;
  logger: EmbeddedPostgresSelfProbeLogger;
  intervalMs?: number;
  runHealthQuery?: (db: Db) => Promise<void>;
};

export type EmbeddedPostgresSelfProbe = {
  runOnce(): Promise<void>;
  start(): void;
  stop(): void;
};

async function defaultRunHealthQuery(db: Db): Promise<void> {
  await db.execute(sql`SELECT 1`);
}

export function createEmbeddedPostgresSelfProbe(
  deps: EmbeddedPostgresSelfProbeDeps,
): EmbeddedPostgresSelfProbe {
  const runHealthQuery = deps.runHealthQuery ?? defaultRunHealthQuery;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<void> {
    try {
      await runHealthQuery(deps.db);
      return;
    } catch (err) {
      deps.logger.warn({ err }, "embedded_postgres_self_probe_failed");
      try {
        await deps.supervisor.recoverIfUnhealthy("probe");
      } catch (rerr) {
        deps.logger.warn({ err: rerr }, "embedded postgres supervisor probe rejected");
      }
    }
  }

  return {
    runOnce,
    start() {
      if (timer) return;
      const intervalMs = deps.intervalMs ?? SELF_PROBE_INTERVAL_MS;
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
