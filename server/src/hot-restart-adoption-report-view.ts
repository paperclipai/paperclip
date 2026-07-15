import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolvePaperclipHomeDir } from "./home-paths.js";
import type { DevServerAdoptionReport } from "./dev-server-status.js";

const MAX_REPORT_BYTES = 64 * 1024;
// Only surface the report while it is fresh enough to be about *this* boot.
// The banner is a post-restart confirmation, not a permanent log.
const DEFAULT_MAX_REPORT_AGE_MS = 15 * 60 * 1000;

/**
 * Read-only view over the completed hot-restart report written on boot by the
 * adoption pass (server/src/hot-restart-report.ts, produced by the P3 backend).
 * Kept decoupled from the writer so the operator UX (PAP-14052) degrades
 * gracefully to `null` when no report file exists yet — an ordinary boot, or a
 * build where the report backend has not landed.
 */
export function getHotRestartReportViewPath(): string {
  return path.join(resolvePaperclipHomeDir(), "hot-restart-report.json");
}

function countStrings(value: unknown): number {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === "string" && entry.trim().length > 0).length
    : 0;
}

export function readRecentHotRestartAdoptionReport(
  now: Date = new Date(),
  maxAgeMs: number = DEFAULT_MAX_REPORT_AGE_MS,
): DevServerAdoptionReport | null {
  const filePath = getHotRestartReportViewPath();
  if (!existsSync(filePath)) return null;

  try {
    if (statSync(filePath).size > MAX_REPORT_BYTES) return null;
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;

    const completedAtRaw = typeof raw.completedAt === "string" ? raw.completedAt : null;
    const completedAt = completedAtRaw ? new Date(completedAtRaw) : null;
    if (!completedAt || !Number.isFinite(completedAt.getTime())) return null;

    const ageMs = now.getTime() - completedAt.getTime();
    if (ageMs < 0 || ageMs > maxAgeMs) return null;

    return {
      completedAt: completedAt.toISOString(),
      newServerVersion: typeof raw.newServerVersion === "string" ? raw.newServerVersion : null,
      adopted: countStrings(raw.adoptedRunIds),
      finalizedWhileDown: countStrings(raw.finalizedWhileDownRunIds),
      lost: countStrings(raw.lostRunIds),
    };
  } catch {
    return null;
  }
}
