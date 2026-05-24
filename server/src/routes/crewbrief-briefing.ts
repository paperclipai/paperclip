import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { getBriefing, getBriefingHtml } from "../services/index.js";

export function crewbriefBriefingRoutes(db: Db) {
  const router = Router();

  router.get("/:tripId/:dutyDayId", async (req, res) => {
    const { tripId, dutyDayId } = req.params;
    const accept = req.headers.accept || "";

    if (accept.includes("text/html")) {
      const html = await getBriefingHtml(db, tripId, dutyDayId);
      if (!html) {
        res.status(404).send("Briefing not found");
        return;
      }
      res.type("html").send(html);
      return;
    }

    const briefing = await getBriefing(db, tripId, dutyDayId);
    if (!briefing) {
      res.status(404).json({ error: "Briefing not found" });
      return;
    }
    res.json(briefing);
  });

  return router;
}
