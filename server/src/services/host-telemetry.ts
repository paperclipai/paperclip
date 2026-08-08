import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultLogsDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ROTATED_FILES_KEPT = 3;

function resolveTelemetryFilePath(): string {
  const logDir = resolveDefaultLogsDir();
  fs.mkdirSync(logDir, { recursive: true });
  return path.join(logDir, "host-telemetry.log");
}

function rotateIfNeeded(filePath: string, maxBytes: number, keep: number) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;

  for (let index = keep - 1; index >= 1; index--) {
    const from = `${filePath}.${index}`;
    const to = `${filePath}.${index + 1}`;
    if (fs.existsSync(from)) {
      fs.renameSync(from, to);
    }
  }
  fs.renameSync(filePath, `${filePath}.1`);
}

function sampleHostResources() {
  const memoryUsage = process.memoryUsage();
  const totalMemBytes = os.totalmem();
  const freeMemBytes = os.freemem();
  return {
    ts: new Date().toISOString(),
    pid: process.pid,
    loadAvg1m: os.loadavg()[0],
    cpuCount: os.cpus().length,
    systemMemUsedBytes: totalMemBytes - freeMemBytes,
    systemMemTotalBytes: totalMemBytes,
    processRssBytes: memoryUsage.rss,
    processHeapUsedBytes: memoryUsage.heapUsed,
    processHeapTotalBytes: memoryUsage.heapTotal,
    uptimeSec: Math.round(process.uptime()),
  };
}

/**
 * Periodically appends a compact CPU/RAM sample line to a rotating host-telemetry
 * log so that "process lost" / resource-pressure incidents (RENA-51447) have
 * historical host-load context to correlate against, since none existed before.
 */
export function startHostResourceTelemetry(options: {
  intervalMs?: number;
  maxFileBytes?: number;
  rotatedFilesKept?: number;
} = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const rotatedFilesKept = options.rotatedFilesKept ?? DEFAULT_ROTATED_FILES_KEPT;

  let filePath: string;
  try {
    filePath = resolveTelemetryFilePath();
  } catch (err) {
    logger.warn({ err }, "host resource telemetry disabled: failed to resolve/create log directory");
    return () => {};
  }

  const tick = () => {
    try {
      rotateIfNeeded(filePath, maxFileBytes, rotatedFilesKept);
      fs.appendFileSync(filePath, `${JSON.stringify(sampleHostResources())}\n`);
    } catch (err) {
      logger.warn({ err }, "host resource telemetry sample failed");
    }
  };

  tick();
  const interval = setInterval(tick, intervalMs);
  interval.unref?.();
  return () => clearInterval(interval);
}
