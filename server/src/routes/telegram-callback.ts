import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { approvals } from "@paperclipai/db";
import { cancelApproveTimer } from "../services/jobs/approve-timer.js";
import type { Db } from "@paperclipai/db";

export function telegramCallbackRoutes(db: Db) {
  const router = Router();

  // Telegram sends callback_query when user taps inline keyboard button
  router.post("/telegram/callback", async (req, res) => {
    // Immediately acknowledge Telegram (required within 3s)
    res.sendStatus(200);

    const callbackQuery = req.body?.callback_query;
    if (!callbackQuery?.data) return;

    const [decision, approvalId] = callbackQuery.data.split(":");
    if (!["approve", "reject"].includes(decision) || !approvalId) return;

    const status = decision === "approve" ? "approved" : "rejected";

    // Atomic update — idempotent
    const result = await db.update(approvals)
      .set({ status, resolvedVia: "telegram", decidedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
      .returning();

    if (result.length > 0) {
      await cancelApproveTimer(approvalId).catch(() => null);
    }
  });

  return router;
}
