import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "./home-paths.js";

const MAX_REPORT_BYTES = 64 * 1024;

export type HotRestartPendingReport = {
  version: 1;
  requestedAt: string;
  previousServerPid: number;
  requestedByRunId: string | null;
  preservedRunIds: string[];
};

export type HotRestartReport = HotRestartPendingReport & {
  completedAt: string;
  newServerPid: number;
  newServerVersion: string;
  adoptedRunIds: string[];
  finalizedWhileDownRunIds: string[];
  lostRunIds: string[];
};

function pendingPath() {
  return path.join(resolvePaperclipHomeDir(), "hot-restart-report-pending.json");
}

export function getHotRestartReportPath() {
  return path.join(resolvePaperclipHomeDir(), "hot-restart-report.json");
}

function unique(values: string[]) {
  return [...new Set(values)];
}

export function writeHotRestartPendingReport(input: HotRestartPendingReport) {
  const filePath = pendingPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(input, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

function consumeHotRestartPendingReport(): HotRestartPendingReport | null {
  const filePath = pendingPath();
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) return null;
    const parsed = JSON.parse(raw) as Partial<HotRestartPendingReport>;
    if (
      parsed.version !== 1 ||
      typeof parsed.requestedAt !== "string" ||
      typeof parsed.previousServerPid !== "number" ||
      !Array.isArray(parsed.preservedRunIds)
    ) {
      return null;
    }
    return {
      version: 1,
      requestedAt: parsed.requestedAt,
      previousServerPid: parsed.previousServerPid,
      requestedByRunId: typeof parsed.requestedByRunId === "string" ? parsed.requestedByRunId : null,
      preservedRunIds: parsed.preservedRunIds.filter((value): value is string => typeof value === "string"),
    };
  } catch {
    return null;
  } finally {
    rmSync(filePath, { force: true });
  }
}

export function completeHotRestartReport(input: {
  newServerVersion: string;
  adoptedRunIds: string[];
  finalizedWhileDownRunIds: string[];
  rejectedRunIds: string[];
  now?: Date;
  newServerPid?: number;
}): HotRestartReport | null {
  const pending = consumeHotRestartPendingReport();
  if (!pending) return null;

  const adoptedRunIds = unique(input.adoptedRunIds);
  const finalizedWhileDownRunIds = unique(input.finalizedWhileDownRunIds);
  const accounted = new Set([...adoptedRunIds, ...finalizedWhileDownRunIds]);
  const lostRunIds = unique([
    ...input.rejectedRunIds,
    ...pending.preservedRunIds.filter((runId) => !accounted.has(runId)),
  ]);
  const report: HotRestartReport = {
    ...pending,
    completedAt: (input.now ?? new Date()).toISOString(),
    newServerPid: input.newServerPid ?? process.pid,
    newServerVersion: input.newServerVersion,
    adoptedRunIds,
    finalizedWhileDownRunIds,
    lostRunIds,
  };
  const filePath = getHotRestartReportPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return report;
}
