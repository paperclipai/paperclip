import type { Router } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assertAgnbAccess } from "../../routes/authz.js";
import { rows } from "../helpers.js";

/**
 * AGNB group: campaigns + rocket (reads).
 * Ported from agnb app/all-gas-no-brakes/api/agnb/campaigns + rocket.
 * Sync routes (rocket/sync-*) call the external Rocket API → Phase 5 (worker).
 */
export function registerCampaigns(router: Router, db: Db) {
  /** GET /api/agnb/campaigns — Rocket campaigns + sender accounts. */
  router.get("/agnb/campaigns", async (req, res) => {
    assertAgnbAccess(req);
    const [campaigns, senders] = await Promise.all([
      db.execute(sql`
        SELECT id, name, status, type, framework,
               sent_count, open_count, click_count, reply_count, meeting_count,
               open_rate, click_rate, reply_rate, meeting_rate
        FROM agnb.rocket_campaigns
        ORDER BY COALESCE(reply_rate, 0) DESC
      `),
      db.execute(sql`
        SELECT id, email, sender_type, status
        FROM agnb.rocket_senders
      `),
    ]);
    res.json({ ok: true, campaigns: rows(campaigns), senders: rows(senders) });
  });
}
