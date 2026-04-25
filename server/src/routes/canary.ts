import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { createCanaryService } from "../services/canary.js";
import { logger } from "../middleware/logger.js";

const upsertPairingSchema = z.object({
  primaryModel: z.string(),
  challengerModel: z.string(),
  primaryHarness: z.string(),
  challengerHarness: z.string(),
  canaryPercent: z.number().optional(),
});

export function canaryRoutes(db?: Db) {
  const router = Router();

  if (!db) {
    router.get("/status/:role", (_req, res) => {
      res.status(503).json({ error: "Database not available" });
    });
    router.get("/status", (_req, res) => {
      res.status(503).json({ error: "Database not available" });
    });
    router.patch("/status/:role", (_req, res) => {
      res.status(503).json({ error: "Database not available" });
    });
    router.put("/pairing/:role", (_req, res) => {
      res.status(503).json({ error: "Database not available" });
    });
    return router;
  }

  const canaryService = createCanaryService(db);

  router.get("/status", async (_req, res) => {
    try {
      const pairings = await canaryService.getAllCanaryPairings();
      res.json({
        success: true,
        data: pairings,
      });
    } catch (err) {
      logger.error({ err }, "Failed to get all canary pairings");
      res.status(500).json({
        error: "Failed to retrieve canary pairings",
        code: "INTERNAL_ERROR",
      });
    }
  });

  router.get("/status/:role", async (req, res) => {
    try {
      const { role } = req.params;
      const pairing = await canaryService.getCanaryPairingForRole(role);

      if (!pairing) {
        res.status(404).json({
          error: `No active canary pairing found for role: ${role}`,
          code: "NOT_FOUND",
        });
        return;
      }

      res.json({
        success: true,
        data: pairing,
      });
    } catch (err) {
      logger.error({ err, role: req.params.role }, "Failed to get canary pairing");
      res.status(500).json({
        error: "Failed to retrieve canary pairing",
        code: "INTERNAL_ERROR",
      });
    }
  });

  router.patch("/status/:role", async (req, res) => {
    try {
      const { role } = req.params;
      const statusSchema = z.object({
        status: z.enum(["active", "paused", "promoted", "rejected"]),
      });

      const parsed = statusSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid status value",
          code: "VALIDATION_ERROR",
          details: parsed.error.flatten(),
        });
        return;
      }

      const pairing = await canaryService.getCanaryPairingForRole(role);

      if (!pairing) {
        res.status(404).json({
          error: `No canary pairing found for role: ${role}`,
          code: "NOT_FOUND",
        });
        return;
      }

      await canaryService.updateCanaryStatus(role, parsed.data.status);

      res.json({
        success: true,
        message: `Canary status updated to ${parsed.data.status}`,
      });
    } catch (err) {
      logger.error({ err, role: req.params.role }, "Failed to update canary status");
      res.status(500).json({
        error: "Failed to update canary status",
        code: "INTERNAL_ERROR",
      });
    }
  });

  router.put("/pairing/:role", async (req, res) => {
    try {
      const { role } = req.params;
      const parsed = upsertPairingSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid request body",
          code: "VALIDATION_ERROR",
          details: parsed.error.flatten(),
        });
        return;
      }

      await canaryService.upsertCanaryPairing({
        role,
        ...parsed.data,
      });

      res.json({
        success: true,
        message: "Canary pairing upserted",
      });
    } catch (err) {
      logger.error({ err, role: req.params.role }, "Failed to upsert canary pairing");
      res.status(500).json({
        error: "Failed to upsert canary pairing",
        code: "INTERNAL_ERROR",
      });
    }
  });

  return router;
}