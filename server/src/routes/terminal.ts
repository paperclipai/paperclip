/**
 * Terminal REST API routes.
 *
 * POST /api/terminal/sessions          — create a new terminal session
 * GET  /api/terminal/sessions          — list active sessions
 * DELETE /api/terminal/sessions/:id    — kill a session
 *
 * The actual terminal I/O happens over WebSocket at /ws/terminal/:sessionId.
 */

import { Router } from "express";
import {
  createTerminalSession,
  listTerminalSessions,
  killTerminalSession,
} from "../realtime/terminal-ws.js";

export function createTerminalRouter(): Router {
  const router = Router();

  // Create a terminal session
  router.post("/sessions", async (req, res) => {
    const { cwd } = req.body as { cwd?: string };
    if (!cwd) {
      res.status(400).json({ error: "cwd is required" });
      return;
    }

    try {
      const sessionId = createTerminalSession(cwd);
      if (!sessionId) {
        res.status(500).json({ error: "node-pty not available or cwd does not exist" });
        return;
      }
      res.json({ sessionId, wsUrl: `/ws/terminal/${sessionId}` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  // List active sessions
  router.get("/sessions", (_req, res) => {
    res.json(listTerminalSessions());
  });

  // Kill a session
  router.delete("/sessions/:id", (req, res) => {
    const killed = killTerminalSession(req.params.id);
    if (!killed) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
