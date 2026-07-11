import { and, eq, notInArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";
import { issueService } from "./issues.js";
import { logger } from "../middleware/logger.js";
import type { ProviderQuotaResult } from "@paperclipai/adapter-utils";

const WEEKLY_QUOTA_LABELS = new Set([
  "Current week (all models)",
  "Current week (Sonnet only)",
  "Current week (Opus only)",
]);

const QUOTA_ALERT_THRESHOLD = 80;
export const QUOTA_ALERT_ORIGIN_KIND = "quota_alert";

async function findCeoAgentId(db: Db, companyId: string): Promise<string | null> {
  const result = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")))
    .orderBy(agents.createdAt)
    .limit(1);
  return result[0]?.id ?? null;
}

async function hasOpenAlertForResetAt(db: Db, companyId: string, resetsAt: string): Promise<boolean> {
  const fingerprint = quotaAlertFingerprint(resetsAt);
  const result = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, QUOTA_ALERT_ORIGIN_KIND),
        eq(issues.originFingerprint, fingerprint),
        notInArray(issues.status, ["done", "cancelled"]),
      ),
    )
    .limit(1);
  return result.length > 0;
}

export function quotaAlertFingerprint(resetsAt: string): string {
  return `quota_alert:weekly:${resetsAt}`;
}

export type GetQuotaWindowsFn = () => Promise<ProviderQuotaResult>;

/**
 * Checks claude_local weekly quota windows and creates a critical issue when any
 * window is at or above the alert threshold. Deduplicates by resetsAt so only one
 * alert is created per reset week.
 */
export async function checkAndFireClaudeLocalQuotaAlert(
  db: Db,
  companyId: string,
  getQuotaWindows: GetQuotaWindowsFn,
): Promise<void> {
  let result: ProviderQuotaResult;
  try {
    result = await getQuotaWindows();
  } catch (err) {
    logger.warn({ err, companyId }, "quota-alert: failed to fetch quota windows");
    return;
  }

  if (!result.ok || result.windows.length === 0) return;

  const triggeredWindows = result.windows.filter(
    (w) =>
      WEEKLY_QUOTA_LABELS.has(w.label) &&
      w.usedPercent != null &&
      w.usedPercent >= QUOTA_ALERT_THRESHOLD &&
      w.resetsAt != null,
  );
  if (triggeredWindows.length === 0) return;

  const issuesSvc = issueService(db);

  for (const window of triggeredWindows) {
    const resetsAt = window.resetsAt!;
    try {
      const alreadyAlerted = await hasOpenAlertForResetAt(db, companyId, resetsAt);
      if (alreadyAlerted) {
        logger.debug({ companyId, window: window.label, resetsAt }, "quota-alert: skipping duplicate alert");
        continue;
      }

      const ceoAgentId = await findCeoAgentId(db, companyId);

      const title = `[QUOTA ALERT] claude_local weekly usage at ${window.usedPercent}% — resets ${resetsAt}`;
      const description = [
        `## claude_local quota threshold exceeded`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| Window | ${window.label} |`,
        `| Current usage | ${window.usedPercent}% |`,
        `| Resets at | ${resetsAt} |`,
        `| Threshold | ${QUOTA_ALERT_THRESHOLD}% |`,
        ``,
        `This alert fires when any claude_local weekly quota window reaches ≥ ${QUOTA_ALERT_THRESHOLD}%.`,
        `A prior quota exhaustion (CAR-4944) caused 60+ heartbeat failures over 2.5 days.`,
        ``,
        `**Action:** Review usage and consider reducing heartbeat frequency or pausing non-critical agents until the quota resets.`,
      ].join("\n");

      await issuesSvc.create(companyId, {
        title,
        description,
        status: "todo",
        priority: "critical",
        assigneeAgentId: ceoAgentId ?? undefined,
        originKind: QUOTA_ALERT_ORIGIN_KIND,
        originFingerprint: quotaAlertFingerprint(resetsAt),
      });

      logger.info(
        { companyId, window: window.label, usedPercent: window.usedPercent, resetsAt },
        "quota-alert: created quota alert issue",
      );
    } catch (err) {
      logger.warn({ err, companyId, window: window.label }, "quota-alert: failed to create quota alert issue");
    }
  }
}
