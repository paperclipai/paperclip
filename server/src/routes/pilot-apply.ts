import { Router } from "express";
import { count, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { pilotApplications } from "@paperclipai/db";
import { pilotApplicationSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { apiRateLimit } from "../middleware/rate-limit.js";
import { sendPilotConfirmationEmail, sendPilotOpsNotification } from "../services/pilot-email.js";

const PILOT_CAP = 10;

export function pilotApplyRoutes(db: Db) {
  const router = Router();
  const limiter = apiRateLimit({ windowMs: 60_000, max: 30 });

  router.get("/public/pilot-apply/status", limiter, async (_req, res) => {
    const [row] = await db
      .select({ count: count() })
      .from(pilotApplications);
    const current = Number(row?.count ?? 0);

    res.json({
      accepting: current < PILOT_CAP,
      count: current,
      cap: PILOT_CAP,
    });
  });

  router.post(
    "/public/pilot-apply",
    limiter,
    validate(pilotApplicationSchema),
    async (req, res) => {
      const { name, email, practiceType, description } = req.body as {
        name: string;
        email: string;
        practiceType: string;
        description: string;
      };

      const result = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ count: count() })
          .from(pilotApplications);
        const current = Number(row?.count ?? 0);

        if (current >= PILOT_CAP) {
          return { waitlisted: true as const };
        }

        await tx.insert(pilotApplications).values({
          name,
          email,
          practiceType,
          description,
        });

        return { success: true as const };
      });

      if ("waitlisted" in result) {
        res.status(200).json({ waitlisted: true });
        return;
      }

      void Promise.all([
        sendPilotConfirmationEmail(name, email),
        sendPilotOpsNotification(name, email, practiceType),
      ]);

      res.status(201).json({ success: true });
    },
  );

  return router;
}
