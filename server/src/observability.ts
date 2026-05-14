import { monitorEventLoopDelay } from "node:perf_hooks";

type RequestMetricKey = string;
type RequestMetricValue = {
  count: number;
  durationSecondsSum: number;
};

const requestMetrics = new Map<RequestMetricKey, RequestMetricValue>();
const eventLoopLag = monitorEventLoopDelay({ resolution: 20 });
eventLoopLag.enable();

function sanitizeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function key(route: string, status: number): string {
  return `${route}::${status}`;
}

export function recordHttpRequestMetric(input: {
  route: string;
  status: number;
  durationSeconds: number;
}) {
  const metricKey = key(input.route, input.status);
  const current = requestMetrics.get(metricKey) ?? { count: 0, durationSecondsSum: 0 };
  current.count += 1;
  current.durationSecondsSum += Math.max(0, input.durationSeconds);
  requestMetrics.set(metricKey, current);
}

export function estimateOpenConnections(): number {
  const getActiveHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles;
  if (typeof getActiveHandles !== "function") return 0;
  const handles = getActiveHandles();
  let sockets = 0;
  for (const handle of handles) {
    const candidate = handle as { remoteAddress?: unknown; localAddress?: unknown };
    if (typeof candidate.remoteAddress === "string" || typeof candidate.localAddress === "string") {
      sockets += 1;
    }
  }
  return sockets;
}

export function getEventLoopLagMs(): number {
  const meanNs = Number(eventLoopLag.mean || 0);
  if (!Number.isFinite(meanNs) || meanNs <= 0) return 0;
  return meanNs / 1_000_000;
}

export function renderPrometheusMetrics(input: {
  logSizeMb: number;
  openConnections: number;
}) {
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

  lines.push("# HELP event_loop_lag_ms Mean event loop lag in milliseconds.");
  lines.push("# TYPE event_loop_lag_ms gauge");
  lines.push(`event_loop_lag_ms ${getEventLoopLagMs().toFixed(3)}`);

  lines.push("# HELP log_size_mb Current server.log size in megabytes.");
  lines.push("# TYPE log_size_mb gauge");
  lines.push(`log_size_mb ${Math.max(0, input.logSizeMb).toFixed(3)}`);

  return `${lines.join("\n")}\n`;
}

