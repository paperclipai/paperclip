/**
 * Synthetic SSH→Paperclip-API probe.
 *
 * Runs every 60s on the API box, exercises the same code path as a real
 * worker lease-acquire (SSH into the worker host, curl /api/health), and
 * persists timing + outcome to `synthetic_ssh_probe_results`. An alert is
 * raised when 3 consecutive results fail, or when the median total over a
 * rolling 5-minute window exceeds 7s — both fire before the 10s probe budget
 * starves a real assigned run.
 *
 * Scope notes (BLO-1491):
 *  - Storage: Postgres, 7-day retention.
 *  - Alert sink: opaque `pageCallback` injected at startup; default wiring
 *    lives in app boot (TODO BLO-1491 followups).
 *  - This service is intentionally side-effect free until `start()` is called.
 */

import {
  findReachablePaperclipApiUrlOverSsh,
  type SshConnectionConfig,
  type PaperclipApiProbeAttempt,
} from "@paperclipai/adapter-utils/ssh";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROBE_INTERVAL_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ALERT_CONSECUTIVE_FAILURES = 3;
const ALERT_WINDOW_MS = 5 * 60 * 1000;
const ALERT_MEDIAN_LATENCY_MS = 7_000;
const ALERT_REPAGE_MS = 15 * 60 * 1000;

export interface SyntheticProbeTarget {
  config: SshConnectionConfig;
  candidates: string[];
}

export interface SyntheticProbeRecord {
  startedAt: Date;
  targetHost: string;
  targetUser: string;
  ok: boolean;
  totalMs: number;
  sshHandshakeMs: number | null;
  curlMs: number | null;
  errorClass: string | null;
  attempts: PaperclipApiProbeAttempt[];
  hostLoadAvg1m: number;
  sshdAuthAttempts: number | null;
}

export interface SyntheticProbeAlert {
  reason: "consecutive_failures" | "high_median_latency";
  detail: string;
  windowStartedAt: Date;
  windowEndedAt: Date;
  sampleCount: number;
}

export type SyntheticProbePager = (alert: SyntheticProbeAlert) => Promise<void> | void;

interface SyntheticProbeOptions {
  db: Db;
  target: SyntheticProbeTarget;
  pager?: SyntheticProbePager;
  intervalMs?: number;
  /** Test seam: skip real probe execution. */
  runProbe?: (target: SyntheticProbeTarget) => Promise<SyntheticProbeRecord>;
  /** Test seam: replace setInterval scheduling. */
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

export class SyntheticSshProbe {
  private readonly opts: Required<Omit<SyntheticProbeOptions, "pager" | "runProbe">> & Pick<SyntheticProbeOptions, "pager" | "runProbe">;
  private timer: NodeJS.Timeout | null = null;
  private lastAlertAt: number = 0;

  constructor(options: SyntheticProbeOptions) {
    this.opts = {
      pager: options.pager,
      runProbe: options.runProbe,
      db: options.db,
      target: options.target,
      intervalMs: options.intervalMs ?? PROBE_INTERVAL_MS,
      setInterval: options.setInterval ?? setInterval,
      clearInterval: options.clearInterval ?? clearInterval,
    };
  }

  start(): void {
    if (this.timer !== null) return;
    void this.tick();
    this.timer = this.opts.setInterval(() => {
      void this.tick();
    }, this.opts.intervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer === null) return;
    this.opts.clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const record = await (this.opts.runProbe ?? runProbeOnce)(this.opts.target);
    await this.persist(record);
    await this.evaluateAlerts();
    await this.pruneOldResults();
  }

  private async persist(record: SyntheticProbeRecord): Promise<void> {
    // TODO(BLO-1491 followup): use drizzle-typed insert once schema is wired
    // through `Db`. Raw SQL is fine for the scaffold and avoids forcing every
    // import site to rebuild while the schema settles.
    await this.opts.db.execute(sql`
      INSERT INTO synthetic_ssh_probe_results (
        started_at, target_host, target_user, ok, total_ms,
        ssh_handshake_ms, curl_ms, error_class, attempts_json,
        host_load_avg_1m, sshd_auth_attempts
      ) VALUES (
        ${record.startedAt.toISOString()},
        ${record.targetHost},
        ${record.targetUser},
        ${record.ok},
        ${record.totalMs},
        ${record.sshHandshakeMs},
        ${record.curlMs},
        ${record.errorClass},
        ${JSON.stringify(record.attempts)}::jsonb,
        ${record.hostLoadAvg1m},
        ${record.sshdAuthAttempts}
      )
    `);
  }

  private async evaluateAlerts(): Promise<void> {
    const now = Date.now();
    const windowStart = new Date(now - ALERT_WINDOW_MS);

    const recent = await this.opts.db.execute(sql`
      SELECT started_at, ok, total_ms
      FROM synthetic_ssh_probe_results
      WHERE target_host = ${this.opts.target.config.host}
        AND started_at >= ${windowStart.toISOString()}
      ORDER BY started_at ASC
    `);

    const rows = (recent as { rows?: Array<{ ok: boolean; total_ms: number; started_at: string }> }).rows ?? [];
    if (rows.length === 0) return;

    const tail = rows.slice(-ALERT_CONSECUTIVE_FAILURES);
    if (tail.length === ALERT_CONSECUTIVE_FAILURES && tail.every((r) => !r.ok)) {
      await this.maybePage({
        reason: "consecutive_failures",
        detail: `${ALERT_CONSECUTIVE_FAILURES} consecutive synthetic SSH→API probes failed against ${this.opts.target.config.username}@${this.opts.target.config.host}`,
        windowStartedAt: new Date(tail[0]!.started_at),
        windowEndedAt: new Date(tail[tail.length - 1]!.started_at),
        sampleCount: tail.length,
      });
      return;
    }

    const median = computeMedian(rows.map((r) => r.total_ms));
    if (median > ALERT_MEDIAN_LATENCY_MS) {
      await this.maybePage({
        reason: "high_median_latency",
        detail: `Median synthetic SSH→API probe total = ${median.toFixed(0)}ms over ${rows.length} samples (threshold ${ALERT_MEDIAN_LATENCY_MS}ms)`,
        windowStartedAt: new Date(rows[0]!.started_at),
        windowEndedAt: new Date(rows[rows.length - 1]!.started_at),
        sampleCount: rows.length,
      });
    }
  }

  private async maybePage(alert: SyntheticProbeAlert): Promise<void> {
    const now = Date.now();
    if (now - this.lastAlertAt < ALERT_REPAGE_MS) return;
    this.lastAlertAt = now;
    if (this.opts.pager) {
      await this.opts.pager(alert);
    }
  }

  private async pruneOldResults(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
    await this.opts.db.execute(
      sql`DELETE FROM synthetic_ssh_probe_results WHERE started_at < ${cutoff}`,
    );
  }
}

async function runProbeOnce(target: SyntheticProbeTarget): Promise<SyntheticProbeRecord> {
  const startedAt = new Date();
  const t0 = Date.now();
  const result = await findReachablePaperclipApiUrlOverSsh({
    config: target.config,
    candidates: target.candidates,
    timeoutMs: PROBE_TIMEOUT_MS,
    // Synthetic probe wants the bare unhealthy signal — retry/budget tuning
    // belongs to the live lease path. One attempt = one observation.
    attempts: 1,
  });
  const totalMs = Date.now() - t0;
  const lastAttempt = result.attempts.at(-1) ?? null;

  return {
    startedAt,
    targetHost: target.config.host,
    targetUser: target.config.username,
    ok: result.url !== null,
    totalMs,
    sshHandshakeMs: extractSshHandshakeMs(lastAttempt),
    curlMs: lastAttempt?.durationMs ?? null,
    errorClass: classifyError(result.attempts),
    attempts: result.attempts,
    hostLoadAvg1m: os.loadavg()[0] ?? 0,
    sshdAuthAttempts: await readSshdAuthAttempts().catch(() => null),
  };
}

function extractSshHandshakeMs(attempt: PaperclipApiProbeAttempt | null): number | null {
  // The library currently reports a single duration per attempt; until we
  // split SSH-connect from curl-execute timing in adapter-utils we return
  // null and rely on totalMs + curlMs. Tracked in BLO-1491 followups.
  if (!attempt) return null;
  return null;
}

function classifyError(attempts: PaperclipApiProbeAttempt[]): string | null {
  const last = attempts.at(-1);
  if (!last || last.ok) return null;
  if (last.classification === "permanent") return `permanent_${last.httpStatus ?? "unknown"}`;
  if (last.exitCode !== 0 && last.exitCode !== null) return `curl_exit_${last.exitCode}`;
  if (last.httpStatus === null) return "ssh_or_network";
  return `http_${last.httpStatus}`;
}

async function readSshdAuthAttempts(): Promise<number | null> {
  // Light counter: number of `Failed`/`Accepted` lines in last 5 minutes of
  // /var/log/auth.log. Returns null when the log is unreadable (non-Linux,
  // permission denied) — caller persists it as null without erroring.
  try {
    const { stdout } = await execFileAsync(
      "sh",
      ["-lc", "grep -E 'sshd' /var/log/auth.log 2>/dev/null | tail -n 200 | wc -l"],
      { timeout: 2_000 },
    );
    const parsed = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}
