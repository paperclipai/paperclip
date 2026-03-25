import type { RequestHandler, Request, Response, NextFunction } from "express";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { count, inArray } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Manual Prometheus text-format metrics (no prom-client dependency)
// ---------------------------------------------------------------------------

interface CounterEntry {
  method: string;
  path: string;
  status: string;
  count: number;
}

interface HistogramBucket {
  method: string;
  path: string;
  le: string;
  count: number;
}

interface HistogramMeta {
  method: string;
  path: string;
  sum: number;
  count: number;
}

const HISTOGRAM_BOUNDARIES = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

// In-memory stores
const requestCounters = new Map<string, CounterEntry>();
const histogramBuckets = new Map<string, HistogramBucket>();
const histogramMeta = new Map<string, HistogramMeta>();
let heartbeatRunsTotalCompleted = 0;
let heartbeatRunsTotalFailed = 0;

function counterKey(method: string, path: string, status: string): string {
  return `${method}|${path}|${status}`;
}

function bucketKey(method: string, path: string, le: string): string {
  return `${method}|${path}|${le}`;
}

function metaKey(method: string, path: string): string {
  return `${method}|${path}`;
}

/**
 * Normalise an Express request path so high-cardinality segments (UUIDs, etc.)
 * are replaced with a placeholder. This keeps the metric label space bounded.
 */
function normalisePath(req: Request): string {
  const route = (req as any).route;
  if (route?.path) {
    // Express matched a named route — use the pattern
    const base = (req as any).baseUrl ?? "";
    return `${base}${route.path}`;
  }
  // Fallback: collapse UUID-like and numeric segments
  return req.path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ":id",
  ).replace(/\/\d+(?=\/|$)/g, "/:id");
}

function recordRequest(method: string, path: string, status: number, durationSec: number): void {
  const statusStr = String(status);

  // Counter
  const ck = counterKey(method, path, statusStr);
  const existing = requestCounters.get(ck);
  if (existing) {
    existing.count += 1;
  } else {
    requestCounters.set(ck, { method, path, status: statusStr, count: 1 });
  }

  // Histogram buckets
  for (const boundary of HISTOGRAM_BOUNDARIES) {
    if (durationSec <= boundary) {
      const bk = bucketKey(method, path, String(boundary));
      const b = histogramBuckets.get(bk);
      if (b) {
        b.count += 1;
      } else {
        histogramBuckets.set(bk, { method, path, le: String(boundary), count: 1 });
      }
    }
  }
  // +Inf bucket
  const infKey = bucketKey(method, path, "+Inf");
  const inf = histogramBuckets.get(infKey);
  if (inf) {
    inf.count += 1;
  } else {
    histogramBuckets.set(infKey, { method, path, le: "+Inf", count: 1 });
  }

  // Histogram sum / count
  const mk = metaKey(method, path);
  const m = histogramMeta.get(mk);
  if (m) {
    m.sum += durationSec;
    m.count += 1;
  } else {
    histogramMeta.set(mk, { method, path, sum: durationSec, count: 1 });
  }
}

// ---------------------------------------------------------------------------
// Middleware: records metrics per request
// ---------------------------------------------------------------------------

export function metricsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip recording metrics for the /metrics endpoint itself
    if (req.path === "/metrics") {
      next();
      return;
    }

    const start = process.hrtime.bigint();

    res.on("finish", () => {
      const durationNs = Number(process.hrtime.bigint() - start);
      const durationSec = durationNs / 1e9;
      const method = req.method;
      const path = normalisePath(req);
      recordRequest(method, path, res.statusCode, durationSec);
    });

    next();
  };
}

// ---------------------------------------------------------------------------
// Expose heartbeat run completions so the middleware can track them.
// Call these from heartbeat service hooks or route handlers.
// ---------------------------------------------------------------------------

export function recordHeartbeatRunCompleted(): void {
  heartbeatRunsTotalCompleted += 1;
}

export function recordHeartbeatRunFailed(): void {
  heartbeatRunsTotalFailed += 1;
}

// ---------------------------------------------------------------------------
// GET /metrics — Prometheus text exposition format
// ---------------------------------------------------------------------------

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

async function renderMetrics(db?: Db): Promise<string> {
  const lines: string[] = [];

  // --- paperclip_http_requests_total ---
  lines.push("# HELP paperclip_http_requests_total Total HTTP requests.");
  lines.push("# TYPE paperclip_http_requests_total counter");
  for (const entry of requestCounters.values()) {
    lines.push(
      `paperclip_http_requests_total{method="${escapeLabel(entry.method)}",path="${escapeLabel(entry.path)}",status="${escapeLabel(entry.status)}"} ${entry.count}`,
    );
  }

  // --- paperclip_http_request_duration_seconds ---
  lines.push("# HELP paperclip_http_request_duration_seconds HTTP request duration in seconds.");
  lines.push("# TYPE paperclip_http_request_duration_seconds histogram");

  // Collect all unique method+path combos
  const allPaths = new Set<string>();
  for (const m of histogramMeta.values()) {
    allPaths.add(metaKey(m.method, m.path));
  }

  for (const pk of allPaths) {
    const m = histogramMeta.get(pk)!;
    // Emit all buckets (including boundaries with 0 if not yet seen)
    let cumulativeCount = 0;
    for (const boundary of HISTOGRAM_BOUNDARIES) {
      const bk = bucketKey(m.method, m.path, String(boundary));
      const b = histogramBuckets.get(bk);
      cumulativeCount += b?.count ?? 0;
      lines.push(
        `paperclip_http_request_duration_seconds_bucket{method="${escapeLabel(m.method)}",path="${escapeLabel(m.path)}",le="${boundary}"} ${cumulativeCount}`,
      );
    }
    // +Inf
    cumulativeCount += 0; // +Inf always equals total count
    lines.push(
      `paperclip_http_request_duration_seconds_bucket{method="${escapeLabel(m.method)}",path="${escapeLabel(m.path)}",le="+Inf"} ${m.count}`,
    );
    lines.push(
      `paperclip_http_request_duration_seconds_sum{method="${escapeLabel(m.method)}",path="${escapeLabel(m.path)}"} ${m.sum}`,
    );
    lines.push(
      `paperclip_http_request_duration_seconds_count{method="${escapeLabel(m.method)}",path="${escapeLabel(m.path)}"} ${m.count}`,
    );
  }

  // --- paperclip_heartbeat_runs_active (gauge — query DB) ---
  lines.push("# HELP paperclip_heartbeat_runs_active Number of currently active heartbeat runs.");
  lines.push("# TYPE paperclip_heartbeat_runs_active gauge");
  let activeRuns = 0;
  if (db) {
    try {
      const [row] = await db
        .select({ count: count() })
        .from(heartbeatRuns)
        .where(inArray(heartbeatRuns.status, ["queued", "running"]));
      activeRuns = Number(row?.count ?? 0);
    } catch {
      // DB unavailable — report 0
    }
  }
  lines.push(`paperclip_heartbeat_runs_active ${activeRuns}`);

  // --- paperclip_heartbeat_runs_total ---
  lines.push("# HELP paperclip_heartbeat_runs_total Total heartbeat runs by status.");
  lines.push("# TYPE paperclip_heartbeat_runs_total counter");
  lines.push(`paperclip_heartbeat_runs_total{status="completed"} ${heartbeatRunsTotalCompleted}`);
  lines.push(`paperclip_heartbeat_runs_total{status="failed"} ${heartbeatRunsTotalFailed}`);

  // --- process metrics ---
  lines.push("# HELP process_resident_memory_bytes Resident memory size in bytes.");
  lines.push("# TYPE process_resident_memory_bytes gauge");
  lines.push(`process_resident_memory_bytes ${process.memoryUsage.rss()}`);

  lines.push("# HELP process_heap_bytes Node.js heap used in bytes.");
  lines.push("# TYPE process_heap_bytes gauge");
  lines.push(`process_heap_bytes ${process.memoryUsage().heapUsed}`);

  lines.push("# HELP nodejs_eventloop_lag_seconds Event loop lag in seconds.");
  lines.push("# TYPE nodejs_eventloop_lag_seconds gauge");
  // Approximate via Date — real perf_hooks would be more accurate but this is lightweight
  const lagStart = Date.now();
  await new Promise<void>((r) => setImmediate(r));
  const lagMs = Date.now() - lagStart;
  lines.push(`nodejs_eventloop_lag_seconds ${lagMs / 1000}`);

  lines.push("");
  return lines.join("\n");
}

export function metricsRoute(db?: Db): Router {
  const router = Router();

  router.get("/metrics", async (req, res) => {
    // Restrict to internal/localhost requests only (Prometheus scrapes via ServiceMonitor)
    const forwarded = req.headers["x-forwarded-for"];
    const ip = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : req.socket.remoteAddress;
    const isInternal = !forwarded || ip === "127.0.0.1" || ip === "::1" || ip?.startsWith("10.") || ip?.startsWith("172.") || ip?.startsWith("192.168.");
    if (!isInternal) {
      res.status(403).json({ error: "Metrics endpoint is internal only" });
      return;
    }
    try {
      const body = await renderMetrics(db);
      res.status(200).set("Content-Type", "text/plain; version=0.0.4; charset=utf-8").end(body);
    } catch (err) {
      res.status(500).json({ error: "Failed to render metrics" });
    }
  });

  return router;
}
