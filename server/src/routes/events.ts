import { Router } from "express";
import type { Db } from "@paperclipai/db";

// The live events endpoint is handled by the WebSocket upgrade handler in
// src/realtime/live-events-ws.ts. This Express route ensures HTTP clients
// receive 426 Upgrade Required instead of a generic 404, and prevents
// polling fallbacks that generate thousands of failed requests per session.
export function eventsRoutes(_db: Db) {
  const router = Router();

  router.get("/companies/:companyId/events/ws", (_req, res) => {
    res
      .status(426)
      .set("Upgrade", "websocket")
      .json({ error: "This endpoint requires a WebSocket connection." });
  });

  return router;
}
