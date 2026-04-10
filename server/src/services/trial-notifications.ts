import { Resend } from "resend";
import { and, eq, gte, lt, isNull, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companySubscriptions,
  companies,
  companyMemberships,
  authUsers,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Send trial expiry warning emails for trials ending within the next 3 days.
 * Each company receives at most one warning per trial (tracked via trialWarningSentAt).
 *
 * Call this periodically from the scheduler loop (e.g. every hour).
 */
export async function sendTrialExpiryWarnings(db: Db): Promise<{ sent: number }> {
  const resendApiKey = process.env.RESEND_API_KEY?.trim();
  if (!resendApiKey) return { sent: 0 };

  const now = new Date();
  // Find trials ending between now and 3 days from now
  const warningWindowEnd = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

  const expiringTrials = await db
    .select({
      companyId: companySubscriptions.companyId,
      trialEndsAt: companySubscriptions.trialEndsAt,
      companyName: companies.name,
    })
    .from(companySubscriptions)
    .innerJoin(companies, eq(companySubscriptions.companyId, companies.id))
    .where(
      and(
        eq(companySubscriptions.status, "trialing"),
        isNotNull(companySubscriptions.trialEndsAt),
        isNull(companySubscriptions.trialWarningSentAt),
        gte(companySubscriptions.trialEndsAt, now),
        lt(companySubscriptions.trialEndsAt, warningWindowEnd),
      ),
    );

  if (expiringTrials.length === 0) return { sent: 0 };

  const emailFrom = process.env.PAPERCLIP_EMAIL_FROM?.trim() || "Paperclip <noreply@paperclip.inc>";
  const publicUrl = process.env.PAPERCLIP_PUBLIC_URL?.trim() ?? "https://paperclip.inc";
  const resend = new Resend(resendApiKey);
  let sent = 0;

  for (const trial of expiringTrials) {
    try {
      const members = await db
        .select({ email: authUsers.email })
        .from(companyMemberships)
        .innerJoin(authUsers, eq(companyMemberships.principalId, authUsers.id))
        .where(
          and(
            eq(companyMemberships.companyId, trial.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.status, "active"),
          ),
        );

      if (members.length === 0) continue;

      const daysLeft = Math.ceil(
        (new Date(trial.trialEndsAt!).getTime() - now.getTime()) / (1000 * 60 * 60 * 24),
      );
      const daysText = daysLeft <= 1 ? "less than a day" : `${daysLeft} days`;
      const companyName = trial.companyName ?? "your company";

      await resend.emails.send({
        from: emailFrom,
        to: members.map((m) => m.email),
        subject: `Your Paperclip trial for ${companyName} ends in ${daysText}`,
        text: [
          `Your 14-day free trial for "${companyName}" ends in ${daysText}.`,
          "",
          `Subscribe now to keep your agents running without interruption:`,
          `${publicUrl}/company/settings`,
          "",
          "After the trial ends, your company will be paused until you subscribe.",
          "",
          "Questions? Reply to this email and we'll help.",
        ].join("\n"),
      });

      await db
        .update(companySubscriptions)
        .set({ trialWarningSentAt: now })
        .where(eq(companySubscriptions.companyId, trial.companyId));

      sent++;
      logger.info(
        { companyId: trial.companyId, daysLeft, recipients: members.length },
        `Sent trial expiry warning for "${companyName}"`,
      );
    } catch (err) {
      logger.error(
        { err, companyId: trial.companyId },
        "Failed to send trial expiry warning email",
      );
    }
  }

  return { sent };
}
