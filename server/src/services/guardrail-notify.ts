import type { Db } from "@paperclipai/db";
import { issueComments } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { BudgetAlertPayload } from "./budgets.js";
import type { MailerService } from "./mailer.js";

export interface GuardrailNotifyOptions {
  db: Db;
  mailer: MailerService;
  /** Fixed, operator-configured recipient. Never derived from user/API input. */
  notifyEmail?: string | null;
  /** Owner/dashboard issue that receives an automatic status comment. */
  notifyIssueId?: string | null;
}

export const GUARDRAIL_LEVEL_LABELS: Record<number, string> = {
  1: "WARN — metered-Agenten pausiert",
  2: "HIGH — nur critical-Agenten aktiv",
  3: "HARD STOP — alle Agenten pausiert",
};

export function guardrailLevelForAlert(alert: BudgetAlertPayload): 1 | 2 | 3 {
  if (alert.thresholdType === "hard") return 3;
  return alert.utilizationPercent >= 85 ? 2 : 1;
}

// Outbound mail policy (defense-in-depth): this service must only ever notify a
// fixed, operator-configured internal Rende address. It must never send to a
// recipient influenced by user/API input, and it must never widen to external
// domains — external notification recipients belong behind the sanctioned
// `rende-mail-send` gate (out of scope for this backend service).
export function isAllowedGuardrailNotifyRecipient(email: string): boolean {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  return domain === "rende.lu";
}

/**
 * Builds the guardrail stage-change notification handler used as the
 * `onBudgetAlert` hook for `budgetService`. Sends an internal email (guarded to
 * rende.lu recipients only) and posts an automatic issue comment with the
 * stage + utilization percent. Never throws — failures are logged and
 * swallowed so a notification problem cannot break budget enforcement.
 */
export function createGuardrailAlertHandler(options: GuardrailNotifyOptions) {
  const { db, mailer, notifyEmail, notifyIssueId } = options;

  return async function onGuardrailAlert(alert: BudgetAlertPayload): Promise<void> {
    const levelNum = guardrailLevelForAlert(alert);
    const levelLabel = GUARDRAIL_LEVEL_LABELS[levelNum] ?? `Stufe ${levelNum}`;
    const subject = `Guardrail ${levelLabel} (${alert.utilizationPercent.toFixed(1)} %)`;
    const body = [
      `Guardrail-Stufe ${levelNum}: ${levelLabel}`,
      `Nutzung: ${alert.utilizationPercent.toFixed(1)} % (${alert.observedCents} / ${alert.limitCents} Cent)`,
      `Scope: ${alert.scopeType} "${alert.scopeName}"`,
    ].join("\n");

    if (notifyEmail) {
      if (!isAllowedGuardrailNotifyRecipient(notifyEmail)) {
        logger.warn(
          { notifyEmail },
          "guardrail notification recipient is not an internal rende.lu address; skipping send",
        );
      } else if (mailer.isConfigured()) {
        await mailer.sendMail({ to: notifyEmail, subject, text: body }).catch((err) => {
          logger.warn({ err }, "guardrail notification email failed to send");
        });
      }
    }

    if (notifyIssueId) {
      await db
        .insert(issueComments)
        .values({
          companyId: alert.companyId,
          issueId: notifyIssueId,
          authorType: "system",
          body: `**Guardrail Stufe ${levelNum}**: ${levelLabel}\n\n- Nutzung: ${alert.utilizationPercent.toFixed(1)} %\n- Scope: ${alert.scopeType} "${alert.scopeName}"`,
        })
        .catch((err) => {
          logger.warn({ err, notifyIssueId }, "guardrail notification issue comment failed to post");
        });
    }
  };
}
