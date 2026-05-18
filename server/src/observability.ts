type HttpMetric = {
  count: number;
  durationSecondsSum: number;
};

const requestMetrics = new Map<string, HttpMetric>();

export function recordHttpRequestMetric(route: string | undefined, status: number, durationMs: number) {
  const key = `${route ?? "unknown"}::${status}`;
  const existing = requestMetrics.get(key);
  if (existing) {
    existing.count++;
    existing.durationSecondsSum += durationMs / 1000;
  } else {
    requestMetrics.set(key, { count: 1, durationSecondsSum: durationMs / 1000 });
  }
}

export function estimateOpenConnections(): number {
  try {
    const handles = (process as any)._getActiveHandles?.() ?? [];
    let sockets = 0;
    for (const h of handles) {
      if (h && typeof h === "object") {
        const constructorName = h.constructor?.name ?? "";
        if (constructorName === "Socket" || constructorName === "Server") {
          sockets++;
        }
        if (h._sockets && typeof h._sockets === "object") {
          sockets += Object.keys(h._sockets).length;
        }
      }
    }
    return sockets;
  } catch {
    return 0;
  }
}

let eventLoopLagMonitor: any = null;
let lastEventLoopLagMs = 0;

function getEventLoopLagMs(): number {
  try {
    const { monitorEventLoopDelay } = require("node:perf_hooks");
    if (!eventLoopLagMonitor) {
      eventLoopLagMonitor = monitorEventLoopDelay();
      eventLoopLagMonitor.enable();
      setInterval(() => {
        lastEventLoopLagMs = (eventLoopLagMonitor.mean || 0) / 1e6;
      }, 5000).unref();
    }
    return lastEventLoopLagMs;
  } catch {
    return 0;
  }
}

function sanitizeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export function renderPrometheusMetrics(input: {
  logSizeMb: number;
  openConnections: number;
}): string {
  const lines: string[] = [];

  lines.push("# HELP requests_total Total HTTP requests grouped by route and status.");
  lines.push("# TYPE requests_total counter");
  lines.push("# HELP request_duration_seconds Total request duration seconds grouped by route and status.");
  lines.push("# TYPE request_duration_seconds counter");

  for (const [metricKey, metric] of requestMetrics) {
    const [route, statusRaw] = metricKey.split("::");
    const status = Number(statusRaw || 0);
    const labels = `route=\"${sanitizeLabel(route || "unknown")}\",status=\"${sanitizeLabel(String(status || 0))}\"`;
    lines.push(`requests_total{${labels}} ${metric.count}`);
    lines.push(`request_duration_seconds{${labels}} ${metric.durationSecondsSum.toFixed(6)}`);
  }

  lines.push("# HELP open_connections Estimated count of active socket handles.");
  lines.push("# TYPE open_connections gauge");
  lines.push(`open_connections ${Math.max(0, Math.floor(input.openConnections))}`);

  lines.push("# HELP event_loop_lag_ms Event loop lag in milliseconds.");
  lines.push("# TYPE event_loop_lag_ms gauge");
  lines.push(`event_loop_lag_ms ${getEventLoopLagMs().toFixed(3)}`);

  lines.push("# HELP log_size_mb Server log file size in megabytes.");
  lines.push("# TYPE log_size_mb gauge");
  lines.push(`log_size_mb ${Number.isFinite(input.logSizeMb) ? input.logSizeMb.toFixed(3) : "0.000"}`);

  lines.push("");
  return lines.join("\n");
}
