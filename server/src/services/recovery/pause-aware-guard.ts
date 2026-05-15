import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { asNumber } from "../../adapters/utils.js";

export const DEFAULT_WATCHDOG_RESUME_WARMUP_MS = 15 * 60 * 1000;

export function watchdogResumeWarmupMs() {
  return Math.max(
    0,
    asNumber(process.env.PAPERCLIP_WATCHDOG_RESUME_WARMUP_MS, DEFAULT_WATCHDOG_RESUME_WARMUP_MS),
  );
}

export async function isCompanyWatchdogPaused(
  db: Db,
  companyId: string,
  now = new Date(),
) {
  const row = await db
    .select({
      status: companies.status,
      pausedAt: companies.pausedAt,
      resumedAt: companies.resumedAt,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId)))
    .then((rows) => rows[0] ?? null);
  if (!row) return false;
  if (row.status === "paused" || row.pausedAt) return true;
  const warmupMs = watchdogResumeWarmupMs();
  return Boolean(row.resumedAt && now.getTime() - row.resumedAt.getTime() < warmupMs);
}
