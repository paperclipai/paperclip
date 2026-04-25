import { Router } from "express";
import { sql } from "drizzle-orm";
import { count } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pilotApplications } from "@paperclipai/db";
import { createPilotApplicationSchema, PILOT_CAP } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { webhookRateLimit } from "../middleware/rate-limit.js";
import { logger } from "../middleware/logger.js";

async function sendPilotEmails(application: { name: string; email: string; practiceType: string; description: string }) {
  const resendKey = process.env.RESEND_API_KEY;
  const opsEmail = process.env.OPS_EMAIL;
  if (!resendKey) {
    logger.warn("RESEND_API_KEY not set — skipping pilot application emails");
    return;
  }

  const confirmationBody = `Hi ${application.name},\n\nThank you for applying to the CARE pilot program. We will review your application and be in touch soon.\n\nBest,\nThe CARE Team`;

  const opsBody = `New pilot application received:\n\nName: ${application.name}\nEmail: ${application.email}\nPractice type: ${application.practiceType}\nDescription: ${application.description}`;

  const sendEmail = async (to: string, subject: string, text: string) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "CARE <noreply@thecare.app>", to, subject, text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "unknown");
      logger.error({ to, status: res.status, body }, "Resend email failed");
    }
  };

  await Promise.allSettled([
    sendEmail(application.email, "CARE Pilot Application Received", confirmationBody),
    ...(opsEmail ? [sendEmail(opsEmail, `New Pilot Application: ${application.name}`, opsBody)] : []),
  ]);
}

export function pilotApplyRoutes(db: Db) {
  const router = Router();

  router.get("/public/pilot-apply/status", webhookRateLimit, async (_req, res) => {
    const [{ value: total }] = await db.select({ value: count() }).from(pilotApplications);
    res.json({ accepting: total < PILOT_CAP, count: total, cap: PILOT_CAP });
  });

  router.post("/public/pilot-apply", webhookRateLimit, validate(createPilotApplicationSchema), async (req, res) => {
    const { name, email, practiceType, description } = req.body;

    const inserted = await db.execute(sql`
      INSERT INTO pilot_applications (name, email, practice_type, description)
      SELECT ${name}, ${email}, ${practiceType}, ${description}
      WHERE (SELECT count(*) FROM pilot_applications) < ${PILOT_CAP}
      RETURNING id
    `);

    const result = { waitlisted: inserted.length === 0 };

    if (result.waitlisted) {
      res.json({ status: "waitlisted" });
      return;
    }

    sendPilotEmails({ name, email, practiceType, description }).catch((err) => {
      logger.error({ err }, "Pilot email send failed");
    });

    res.json({ status: "success" });
  });

  return router;
}
