/**
 * AgencyTrialWorker — background ticker that manages agency trial lifecycle.
 *
 * Responsibilities:
 * - Send day-7 check-in email to trials that are 7+ days old and haven't received it yet
 * - Send day-25 pre-expiry warning to trials ending in ≤5 days
 * - Expire active trials whose trial_ends_at has passed
 *
 * Ticks every hour by default (configurable for tests).
 */

import { and, eq, isNull, lt, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agencyTrials, agencyTrialEmails, agencyWebhookConfigs } from "@paperclipai/db";
import type { AgencyEmailClient, TrialEmailData } from "./agency-email.js";

const DEFAULT_TICK_MS = 60 * 60 * 1000; // 1 hour

export class AgencyTrialWorker {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly emailClient: AgencyEmailClient,
    private readonly webhookBaseUrl: string,
    private readonly tickMs = DEFAULT_TICK_MS,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // Run one tick immediately on start so emails fire on server restart if due
    void this.tick();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    await Promise.all([
      this.sendDaySevenEmails(),
      this.sendDayTwentyFiveEmails(),
      this.expireStaleTrials(),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Day-7 check-in emails
  // ---------------------------------------------------------------------------

  private async sendDaySevenEmails(): Promise<void> {
    // Active trials that started ≥7 days ago and haven't received a day7 email
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows = await this.db
      .select({
        trialId: agencyTrials.id,
        contactEmail: agencyTrials.contactEmail,
        contactName: agencyTrials.contactName,
        incidentCount: agencyTrials.incidentCount,
        incidentCap: agencyTrials.incidentCap,
        trialEndsAt: agencyTrials.trialEndsAt,
        agencyName: agencyWebhookConfigs.agencyName,
        agencyCode: agencyWebhookConfigs.agencyCode,
      })
      .from(agencyTrials)
      .innerJoin(agencyWebhookConfigs, eq(agencyTrials.agencyWebhookConfigId, agencyWebhookConfigs.id))
      .where(
        and(
          eq(agencyTrials.trialStatus, "active"),
          lte(agencyTrials.trialStartedAt, sevenDaysAgo),
          // Exclude trials that already got day7 email (NOT IN sub-select)
          sql`${agencyTrials.id} NOT IN (
            SELECT trial_id FROM agency_trial_emails WHERE email_type = 'day7'
          )`,
        ),
      )
      .limit(50);

    for (const row of rows) {
      const data: TrialEmailData = {
        trialId: row.trialId,
        contactEmail: row.contactEmail,
        contactName: row.contactName,
        agencyName: row.agencyName,
        agencyCode: row.agencyCode,
        webhookUrl: `${this.webhookBaseUrl}/api/cad/webhook`,
        trialEndsAt: row.trialEndsAt,
        incidentCount: row.incidentCount,
        incidentCap: row.incidentCap,
      };
      try {
        await this.emailClient.sendDay7(data);
        await this.db
          .insert(agencyTrialEmails)
          .values({ trialId: row.trialId, emailType: "day7" })
          .onConflictDoNothing();
      } catch (err) {
        console.warn(`[agency-trial-worker] day7 email failed for ${row.trialId}:`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Day-25 pre-expiry emails
  // ---------------------------------------------------------------------------

  private async sendDayTwentyFiveEmails(): Promise<void> {
    // Active trials ending within the next 5 days that haven't got day25 email
    const fiveDaysFromNow = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    const rows = await this.db
      .select({
        trialId: agencyTrials.id,
        contactEmail: agencyTrials.contactEmail,
        contactName: agencyTrials.contactName,
        incidentCount: agencyTrials.incidentCount,
        incidentCap: agencyTrials.incidentCap,
        trialEndsAt: agencyTrials.trialEndsAt,
        agencyName: agencyWebhookConfigs.agencyName,
        agencyCode: agencyWebhookConfigs.agencyCode,
      })
      .from(agencyTrials)
      .innerJoin(agencyWebhookConfigs, eq(agencyTrials.agencyWebhookConfigId, agencyWebhookConfigs.id))
      .where(
        and(
          eq(agencyTrials.trialStatus, "active"),
          lte(agencyTrials.trialEndsAt, fiveDaysFromNow),
          sql`${agencyTrials.id} NOT IN (
            SELECT trial_id FROM agency_trial_emails WHERE email_type = 'day25'
          )`,
        ),
      )
      .limit(50);

    for (const row of rows) {
      const data: TrialEmailData = {
        trialId: row.trialId,
        contactEmail: row.contactEmail,
        contactName: row.contactName,
        agencyName: row.agencyName,
        agencyCode: row.agencyCode,
        webhookUrl: `${this.webhookBaseUrl}/api/cad/webhook`,
        trialEndsAt: row.trialEndsAt,
        incidentCount: row.incidentCount,
        incidentCap: row.incidentCap,
      };
      try {
        await this.emailClient.sendDay25(data);
        await this.db
          .insert(agencyTrialEmails)
          .values({ trialId: row.trialId, emailType: "day25" })
          .onConflictDoNothing();
      } catch (err) {
        console.warn(`[agency-trial-worker] day25 email failed for ${row.trialId}:`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Expire stale trials
  // ---------------------------------------------------------------------------

  private async expireStaleTrials(): Promise<void> {
    const now = new Date();
    await this.db
      .update(agencyTrials)
      .set({ trialStatus: "expired", updatedAt: now })
      .where(and(eq(agencyTrials.trialStatus, "active"), lt(agencyTrials.trialEndsAt, now)));
  }
}
