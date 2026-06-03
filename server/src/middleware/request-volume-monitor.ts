/**
 * Lightweight request volume and slow-request monitor.
 * Logs a warning when any route pattern receives >SPIKE_THRESHOLD requests
 * in a WINDOW_MS sliding window, and logs slow requests (>SLOW_MS).
 *
 * Routes are bucketed by normalised pattern (IDs replaced with ":id") so
 * per-issue and per-company bursts are counted together.
 */
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

const WINDOW_MS = 60_000;
const SPIKE_THRESHOLD = 60;
const SLOW_MS = 300;

const WATCHED_PATTERNS: RegExp[] = [
  /^\/api\/companies\/[^/]+\/issues(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/dashboard(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/live-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/heartbeat-runs(?:\/|$)/,
  /^\/api\/companies\/[^/]+\/sidebar-badges(?:\/|$)/,
];

function normalisePath(url: string): string {
  const pathname = url.split("?")[0] ?? url;
  return pathname.replace(/\/[0-9a-f-]{8,}/gi, "/:id");
}

interface WindowEntry {
  count: number;
  windowStart: number;
  spikeLogged: boolean;
}

const counters = new Map<string, WindowEntry>();

function recordHit(pattern: string, now: number): WindowEntry {
  let entry = counters.get(pattern);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    entry = { count: 0, windowStart: now, spikeLogged: false };
    counters.set(pattern, entry);
  }
  entry.count++;
  return entry;
}

export function requestVolumeMonitor(req: Request, res: Response, next: NextFunction): void {
  const url = req.url ?? "";
  const method = req.method ?? "";
  const path = normalisePath(url);

  const matched = WATCHED_PATTERNS.some((p) => p.test(url));
  if (!matched) {
    next();
    return;
  }

  const startMs = Date.now();

  const onFinish = () => {
    res.removeListener("finish", onFinish);
    const elapsed = Date.now() - startMs;

    const now = Date.now();
    const entry = recordHit(path, now);

    if (elapsed >= SLOW_MS) {
      logger.warn(
        { path, method, statusCode: res.statusCode, responseTimeMs: elapsed },
        `slow request: ${method} ${path} took ${elapsed}ms`,
      );
    }

    if (entry.count >= SPIKE_THRESHOLD && !entry.spikeLogged) {
      entry.spikeLogged = true;
      const windowSec = Math.round(WINDOW_MS / 1000);
      logger.warn(
        { path, count: entry.count, windowSec },
        `request volume spike: ${entry.count} calls to ${path} in ${windowSec}s window`,
      );
    }
  };

  res.on("finish", onFinish);
  next();
}
