import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { RECOVERY_ORIGIN_KINDS } from "./origins.js";

export const WATCHDOG_FAMILY_ORIGIN_KINDS = [
  RECOVERY_ORIGIN_KINDS.issueProductivityReview,
  RECOVERY_ORIGIN_KINDS.strandedIssueRecovery,
  RECOVERY_ORIGIN_KINDS.staleActiveRunEvaluation,
  RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
  RECOVERY_ORIGIN_KINDS.watchdogRollup,
] as const;

type WatchdogFamilyOriginKind = (typeof WATCHDOG_FAMILY_ORIGIN_KINDS)[number];

function isWatchdogOriginKind(originKind: string | null | undefined): originKind is WatchdogFamilyOriginKind {
  return WATCHDOG_FAMILY_ORIGIN_KINDS.includes(originKind as WatchdogFamilyOriginKind);
}

export async function isWatchdogFamilyDescendant(
  db: Db,
  issue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "parentId" | "originKind" | "originId">,
  opts?: { maxDepth?: number },
) {
  if (isWatchdogOriginKind(issue.originKind)) return true;

  const maxDepth = opts?.maxDepth ?? 25;
  const seen = new Set<string>([issue.id]);
  let parentId = issue.parentId;
  let depth = 0;

  while (parentId && depth < maxDepth) {
    if (seen.has(parentId)) return false;
    seen.add(parentId);
    const parent = await db
      .select({
        id: issues.id,
        parentId: issues.parentId,
        originKind: issues.originKind,
      })
      .from(issues)
      .where(and(eq(issues.companyId, issue.companyId), eq(issues.id, parentId), isNull(issues.hiddenAt)))
      .then((rows) => rows[0] ?? null);
    if (!parent) return false;
    if (isWatchdogOriginKind(parent.originKind)) return true;
    parentId = parent.parentId;
    depth += 1;
  }

  const originId = typeof issue.originId === "string" && issue.originId.trim() ? issue.originId : null;
  if (!originId || seen.has(originId)) return false;
  const [originIssue] = await db
    .select({ id: issues.id, originKind: issues.originKind })
    .from(issues)
    .where(and(
      eq(issues.companyId, issue.companyId),
      eq(issues.id, originId),
      isNull(issues.hiddenAt),
      inArray(issues.originKind, [...WATCHDOG_FAMILY_ORIGIN_KINDS]),
    ))
    .limit(1);
  return Boolean(originIssue);
}
