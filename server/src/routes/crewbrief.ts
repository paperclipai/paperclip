import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, eq, count } from "drizzle-orm";
import {
  crewbriefWaitlistEntries,
  crewbriefReferrals,
} from "@paperclipai/db";
import {
  waitlistSignupSchema,
  referralTrackSchema,
  emailTriggerSchema,
  emailTemplates,
} from "@paperclipai/shared";
import type { CrewbriefConfig } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import type { CrewbriefNurtureService } from "../services/crewbrief-nurture.js";
import type { CrewbriefHubspotService } from "../services/crewbrief-hubspot.js";
import type { CrewbriefWebhookService } from "../services/crewbrief-webhooks.js";

function generateReferralCode(): string {
  return randomBytes(6).toString("base64url").slice(0, 8);
}

async function getNextQueuePosition(db: Db): Promise<number> {
  const result = await db
    .select({ count: count() })
    .from(crewbriefWaitlistEntries);
  return (result[0]?.count ?? 0) + 1;
}

function calculateTier(referralCount: number): string {
  if (referralCount >= 5) return "insider";
  if (referralCount >= 3) return "priority";
  return "standard";
}

export function crewbriefRoutes(
  db: Db,
  config: CrewbriefConfig,
  nurture: CrewbriefNurtureService,
  hubspot?: CrewbriefHubspotService,
  webhooks?: CrewbriefWebhookService,
) {
  const router = Router();

  router.post("/waitlist/signup", validate(waitlistSignupSchema), async (req, res) => {
    const input = req.body;
    const existing = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(eq(crewbriefWaitlistEntries.email, input.email))
      .limit(1);

    if (existing.length > 0) {
      res.status(200).json({
        id: existing[0].id,
        email: existing[0].email,
        queuePosition: existing[0].queuePosition,
        referralCode: existing[0].referralCode,
        tier: existing[0].tier,
        status: existing[0].status,
      });
      return;
    }

    const queuePosition = await getNextQueuePosition(db);
    const referralCode = generateReferralCode();

    if (input.referralCode) {
      const referrer = await db
        .select()
        .from(crewbriefWaitlistEntries)
        .where(eq(crewbriefWaitlistEntries.referralCode, input.referralCode))
        .limit(1);

      if (referrer.length > 0) {
        await db.insert(crewbriefReferrals).values({
          referrerId: referrer[0].id,
          refereeEmail: input.email,
          referralCode: input.referralCode,
          status: "pending",
        });
      }
    }

    const utmSource = input.utmSource ?? null;
    const effectiveSource = utmSource ?? input.source ?? "direct";

    const [entry] = await db
      .insert(crewbriefWaitlistEntries)
      .values({
        name: input.name,
        email: input.email,
        role: input.role,
        organization: input.organization ?? null,
        source: effectiveSource,
        utmSource: utmSource,
        utmMedium: input.utmMedium ?? null,
        utmCampaign: input.utmCampaign ?? null,
        utmTerm: input.utmTerm ?? null,
        utmContent: input.utmContent ?? null,
        referralCode,
        queuePosition,
        tier: "standard",
        status: "waitlisted",
      })
      .returning();

    await nurture.handleWaitlistSignup({
      id: entry.id,
      name: entry.name,
      email: entry.email,
      queuePosition: entry.queuePosition,
      referralCode: entry.referralCode,
      referralCount: entry.referralCount,
      role: entry.role,
      source: entry.source,
      utmSource: entry.utmSource,
      utmMedium: entry.utmMedium,
      utmCampaign: entry.utmCampaign,
      utmTerm: entry.utmTerm,
      utmContent: entry.utmContent,
    });

    res.status(201).json({
      id: entry.id,
      email: entry.email,
      queuePosition: entry.queuePosition,
      referralCode: entry.referralCode,
      tier: entry.tier,
      status: entry.status,
    });
  });

  router.post("/waitlist/referral", validate(referralTrackSchema), async (req, res) => {
    const { referralCode, refereeEmail } = req.body;

    const referrer = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(eq(crewbriefWaitlistEntries.referralCode, referralCode))
      .limit(1);

    if (referrer.length === 0) {
      res.status(404).json({ error: "Invalid referral code" });
      return;
    }

    const existingRef = await db
      .select()
      .from(crewbriefReferrals)
      .where(
        and(
          eq(crewbriefReferrals.referrerId, referrer[0].id),
          eq(crewbriefReferrals.refereeEmail, refereeEmail),
        ),
      )
      .limit(1);

    if (existingRef.length > 0) {
      res.status(200).json({ status: existingRef[0].status });
      return;
    }

    const [ref] = await db
      .insert(crewbriefReferrals)
      .values({
        referrerId: referrer[0].id,
        refereeEmail,
        referralCode,
        status: "pending",
      })
      .returning();

    res.status(201).json({ id: ref.id, status: ref.status });
  });

  router.post("/waitlist/referral/convert", validate(referralTrackSchema), async (req, res) => {
    const { referralCode, refereeEmail } = req.body;

    const referrer = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(eq(crewbriefWaitlistEntries.referralCode, referralCode))
      .limit(1);

    if (referrer.length === 0) {
      res.status(404).json({ error: "Invalid referral code" });
      return;
    }

    const referralRows = await db
      .select()
      .from(crewbriefReferrals)
      .where(
        and(
          eq(crewbriefReferrals.referrerId, referrer[0].id),
          eq(crewbriefReferrals.refereeEmail, refereeEmail),
        ),
      )
      .limit(1);

    if (referralRows.length === 0) {
      res.status(404).json({ error: "Referral not found" });
      return;
    }

    await db
      .update(crewbriefReferrals)
      .set({ status: "converted", convertedAt: new Date() })
      .where(eq(crewbriefReferrals.id, referralRows[0].id));

    const newCount = referrer[0].referralCount + 1;
    const newTier = calculateTier(newCount);

    await db
      .update(crewbriefWaitlistEntries)
      .set({
        referralCount: newCount,
        tier: newTier,
      })
      .where(eq(crewbriefWaitlistEntries.id, referrer[0].id));

    if (newTier === "priority" && referrer[0].tier !== "priority") {
    }
    if (newTier === "insider" && referrer[0].tier !== "insider") {
    }

    await nurture.handleReferralConversion(
      {
        id: referrer[0].id,
        name: referrer[0].name,
        email: referrer[0].email,
        queuePosition: referrer[0].queuePosition,
        referralCode: referrer[0].referralCode,
        referralCount: newCount,
      },
      refereeEmail,
    );

    res.status(200).json({
      status: "converted",
      referralCount: newCount,
      tier: newTier,
    });
  });

  router.post("/waitlist/:id/invite", async (req, res) => {
    const { id } = req.params;
    const { accessToken } = req.body as { accessToken?: string };

    const entries = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(eq(crewbriefWaitlistEntries.id, id))
      .limit(1);

    if (entries.length === 0) {
      res.status(404).json({ error: "Waitlist entry not found" });
      return;
    }

    const entry = entries[0];
    const token = accessToken || generateReferralCode();

    await nurture.handleBetaInvitation(
      {
        id: entry.id,
        name: entry.name,
        email: entry.email,
        queuePosition: entry.queuePosition,
        referralCode: entry.referralCode,
        referralCount: entry.referralCount,
      },
      token,
    );

    res.status(200).json({ status: "invited" });
  });

  router.post("/waitlist/:id/activate", async (req, res) => {
    const { id } = req.params;

    const entries = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(eq(crewbriefWaitlistEntries.id, id))
      .limit(1);

    if (entries.length === 0) {
      res.status(404).json({ error: "Waitlist entry not found" });
      return;
    }

    await nurture.handleBetaActivation({
      id: entries[0].id,
      name: entries[0].name,
      email: entries[0].email,
      queuePosition: entries[0].queuePosition,
      referralCode: entries[0].referralCode,
      referralCount: entries[0].referralCount,
    });

    res.status(200).json({ status: "activated" });
  });

  router.post("/email/send", validate(emailTriggerSchema), async (req, res) => {
    const { waitlistEntryId, templateName } = req.body;

    if (!emailTemplates.includes(templateName as typeof emailTemplates[number])) {
      res.status(400).json({
        error: `Unknown template. Valid: ${emailTemplates.join(", ")}`,
      });
      return;
    }

    const entries = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(eq(crewbriefWaitlistEntries.id, waitlistEntryId))
      .limit(1);

    if (entries.length === 0) {
      res.status(404).json({ error: "Waitlist entry not found" });
      return;
    }

    const vars = {
      name: entries[0].name,
      email: entries[0].email,
      queuePosition: String(entries[0].queuePosition),
      referralCode: entries[0].referralCode,
      referralCount: String(entries[0].referralCount),
      baseUrl: config.CREWBRIEF_BASE_URL,
    };

    const result = await nurture.sendNurtureEmail(
      waitlistEntryId,
      entries[0].email,
      templateName,
      vars,
    );

    if (result.error) {
      res.status(500).json({ error: result.error });
      return;
    }

    res.status(200).json({
      status: "sent",
      messageId: result.messageId,
    });
  });

  router.post("/nurture/process-scheduled", async (_req, res) => {
    const sent = await nurture.processScheduledEmails();
    res.status(200).json({ processed: sent });
  });

  router.get("/waitlist", async (req, res) => {
    const status = req.query.status as string | undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const query = db
      .select()
      .from(crewbriefWaitlistEntries)
      .limit(limit)
      .offset(offset)
      .orderBy(crewbriefWaitlistEntries.createdAt);

    if (status) {
      query.where(eq(crewbriefWaitlistEntries.status, status));
    }

    const entries = await query;
    const totalResult = await db
      .select({ count: count() })
      .from(crewbriefWaitlistEntries);
    const total = totalResult[0]?.count ?? 0;

    res.status(200).json({ entries, total, limit, offset });
  });

  router.get("/waitlist/stats", async (_req, res) => {
    const totalResult = await db
      .select({ count: count() })
      .from(crewbriefWaitlistEntries);
    const total = totalResult[0]?.count ?? 0;

    const statusCounts = await db
      .select({
        status: crewbriefWaitlistEntries.status,
        count: count(),
      })
      .from(crewbriefWaitlistEntries)
      .groupBy(crewbriefWaitlistEntries.status);

    const referralResult = await db
      .select({ count: count() })
      .from(crewbriefReferrals);
    const referralCount = referralResult[0]?.count ?? 0;

    res.status(200).json({
      total,
      byStatus: Object.fromEntries(statusCounts.map((r) => [r.status, r.count])),
      totalReferrals: referralCount,
    });
  });

  router.post("/webhook/hubspot", async (req, res) => {
    if (!webhooks) {
      res.status(501).json({ error: "Webhook service not configured" });
      return;
    }

    const events = Array.isArray(req.body) ? req.body : [req.body];
    await webhooks.handleBatchHubSpotEvents(events);
    res.status(200).json({ received: events.length });
  });

  router.post("/nurture/check-enrollments", async (_req, res) => {
    try {
      const result = await nurture.checkAllEnrollments();
      res.status(200).json(result);
    } catch (err) {
      res.status(500).json({ error: `Enrollment check failed: ${(err as Error).message}` });
    }
  });

  router.post("/nurture/enroll", async (req, res) => {
    const { waitlistEntryId, sequenceId } = req.body as { waitlistEntryId?: string; sequenceId?: string };
    if (!waitlistEntryId || !sequenceId) {
      res.status(400).json({ error: "waitlistEntryId and sequenceId are required" });
      return;
    }

    const entries = await db
      .select()
      .from(crewbriefWaitlistEntries)
      .where(eq(crewbriefWaitlistEntries.id, waitlistEntryId))
      .limit(1);

    if (entries.length === 0) {
      res.status(404).json({ error: "Waitlist entry not found" });
      return;
    }

    const entry = entries[0];
    const err = await nurture.enrollInSequence(
      entry.id, entry.email,
      { id: entry.id, name: entry.name, email: entry.email, queuePosition: entry.queuePosition, referralCode: entry.referralCode, referralCount: entry.referralCount },
      sequenceId,
    );

    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    res.status(200).json({ status: "enrolled", sequenceId });
  });

  router.get("/nurture/sequences", (_req, res) => {
    const sequences = nurture.SEQUENCES.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      triggerDescription: s.triggerDescription,
      emailCount: s.emails.length,
    }));
    res.status(200).json({ sequences });
  });

  router.post("/track", async (req, res) => {
    const ANALYTICS_EVENTS_FILE = "/opt/paperclip/server/crewbrief-analytics-events.jsonl";
    try {
      const event = req.body;
      if (event && typeof event === "object") {
        appendFileSync(ANALYTICS_EVENTS_FILE, JSON.stringify({ ...event, capturedAt: new Date().toISOString() }) + "\n", "utf-8");
      }
    } catch { /* ignore */ }
    res.json({ status: "ok" });
  });

  router.post("/hubspot/properties", async (_req, res) => {
    if (!hubspot) {
      res.status(501).json({ error: "HubSpot service not configured" });
      return;
    }
    const { error } = await hubspot.ensureContactProperties();
    if (error) {
      res.status(500).json({ error });
      return;
    }
    res.status(200).json({ status: "properties_created" });
  });

  return router;
}
