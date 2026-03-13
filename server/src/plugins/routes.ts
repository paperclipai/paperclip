import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import type { ProcessManager } from "./process-manager.js";

/**
 * Create Express router for plugin HTTP routes.
 * Mounted at /api/plugins/:pluginId/*
 * Forwards requests to plugin workers via handleRequest RPC.
 */
export function pluginRoutes(db: Db, processManager: ProcessManager): Router {
  const router = Router();

  router.all("/:pluginId/{*path}", async (req: Request, res: Response) => {
    const pluginId = String(req.params.pluginId);
    const subPath = "/" + String(req.params.path ?? "");

    if (!processManager.isReady(pluginId)) {
      res.status(503).json({ error: `Plugin ${pluginId} is not available` });
      return;
    }

    try {
      const result = await processManager.call(pluginId, "handleRequest", {
        method: req.method,
        path: subPath,
        headers: req.headers as Record<string, string>,
        query: req.query as Record<string, string>,
        body: req.body,
        params: {},
        auth: {
          userId: (req as any).actor?.userId,
          agentId: (req as any).actor?.agentId,
          actorType: (req as any).actor?.type ?? "system",
        },
      });

      const response = result as { status: number; headers?: Record<string, string>; body: unknown };
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          res.setHeader(key, value);
        }
      }
      res.status(response.status ?? 200).json(response.body);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Internal plugin error",
      });
    }
  });

  return router;
}
