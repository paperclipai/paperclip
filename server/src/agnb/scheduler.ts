import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { AGNB_JOBS } from "./jobs/registry.js";
import type { AgnbJobDef, AgnbJobResult } from "./jobs/types.js";

interface JobState {
  def: AgnbJobDef;
  enabled: boolean;
  running: boolean;
  lastRunAt: number | null;
  lastResult: AgnbJobResult | { ok: false; error: string } | null;
  lastDurationMs: number | null;
}

const TICK_MS = 15_000;

/**
 * Lightweight server-side scheduler for ported AGNB jobs. Interval-based (not
 * cron). Single-process; skips overlapping runs. Mirrors the standalone AGNB
 * worker. See docs/migration/AGNB_CONSOLIDATION.md Phase 5.
 */
export function createAgnbScheduler(db: Db) {
  const states = new Map<string, JobState>();
  for (const def of AGNB_JOBS) {
    states.set(def.key, {
      def,
      enabled: def.enabledByDefault ?? false,
      running: false,
      lastRunAt: null,
      lastResult: null,
      lastDurationMs: null,
    });
  }

  const abort = new AbortController();
  let timer: NodeJS.Timeout | null = null;

  function missingEnv(def: AgnbJobDef): string[] {
    return (def.requiresEnv ?? []).filter((k) => !process.env[k]);
  }

  async function runJob(key: string, trigger: "schedule" | "manual"): Promise<JobState> {
    const st = states.get(key);
    if (!st) throw new Error(`unknown job: ${key}`);
    if (st.running) return st;
    const missing = missingEnv(st.def);
    if (missing.length > 0) {
      st.lastResult = { ok: false, error: `missing env: ${missing.join(", ")}` };
      st.lastRunAt = Date.now();
      logger.warn({ job: key, missing }, "agnb job skipped — missing env");
      return st;
    }
    st.running = true;
    const start = Date.now();
    logger.info({ job: key, trigger }, "agnb job start");
    try {
      const result = await st.def.handler({
        db,
        signal: abort.signal,
        log: (msg, extra) => logger.info({ job: key, ...extra }, `agnb:${key} ${msg}`),
      });
      st.lastResult = result;
      logger.info({ job: key, durationMs: Date.now() - start, summary: result.summary }, "agnb job done");
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      st.lastResult = { ok: false, error };
      logger.error({ job: key, error }, "agnb job failed");
    } finally {
      st.running = false;
      st.lastRunAt = Date.now();
      st.lastDurationMs = Date.now() - start;
    }
    return st;
  }

  function tick() {
    const now = Date.now();
    for (const st of states.values()) {
      if (!st.enabled || st.running) continue;
      const due = st.lastRunAt === null || now - st.lastRunAt >= st.def.intervalMs;
      if (due) void runJob(st.def.key, "schedule");
    }
  }

  return {
    start() {
      if (timer) return;
      logger.info({ jobs: AGNB_JOBS.map((j) => j.key) }, "agnb scheduler started");
      timer = setInterval(tick, TICK_MS);
      // Do not run immediately on boot — let the first interval elapse.
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      abort.abort();
    },
    runNow: (key: string) => runJob(key, "manual"),
    list: () =>
      Array.from(states.values()).map((s) => ({
        key: s.def.key,
        enabled: s.enabled,
        running: s.running,
        intervalMs: s.def.intervalMs,
        lastRunAt: s.lastRunAt,
        lastDurationMs: s.lastDurationMs,
        lastResult: s.lastResult,
        missingEnv: missingEnv(s.def),
      })),
    setEnabled: (key: string, enabled: boolean) => {
      const st = states.get(key);
      if (st) st.enabled = enabled;
      return st;
    },
  };
}

export type AgnbScheduler = ReturnType<typeof createAgnbScheduler>;

// Module singleton so route handlers can reach the running scheduler without
// threading it through createApp.
let current: AgnbScheduler | null = null;
export function setAgnbScheduler(s: AgnbScheduler) {
  current = s;
}
export function getAgnbScheduler(): AgnbScheduler | null {
  return current;
}
