import { Router } from "express";
import { wakeConnectionEvents } from "../services/connection-event-wake.js";

export function connectionEventWakeRoutes(owner: object) {
  const router = Router();
  router.post("/api/instance/connector-events/wake", (req, res) => {
    if (req.actor.source !== "cloud_control") { res.status(403).json({ error: "cloud_control_required" }); return; }
    res.set("Cache-Control", "no-store");
    if (!wakeConnectionEvents(owner)) { res.status(503).json({ error: "connection_event_receiver_unavailable" }); return; }
    res.status(202).json({ accepted: true });
  });
  return router;
}
