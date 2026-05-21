import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { instanceRetentionConfig } from "@paperclipai/db";
import { isNull } from "drizzle-orm";
import { forbidden } from "../errors.js";
import { getRetentionConfig } from "../services/heartbeat-compaction.js";

const DEFAULT_SUCCEEDED_RETENTION_HOURS = 72;
const DEFAULT_FAILED_RETENTION_HOURS = 168;

const patchRetentionConfigSchema = z.object({
  succeededRunRetentionHours: z.number().int().positive().optional(),
  failedRunRetentionHours: z.number().int().positive().optional(),
});

function assertInstanceAdmin(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export function retentionConfigRoutes(db: Db) {
  const router = Router();

  router.get("/admin/retention-config", async (req, res) => {
    assertInstanceAdmin(req);
    const config = await getRetentionConfig(db);
    res.json(config);
  });

  router.patch("/admin/retention-config", async (req, res) => {
    assertInstanceAdmin(req);

    const parsed = patchRetentionConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body", issues: parsed.error.issues });
      return;
    }

    const updates = parsed.data;
    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    const existing = await db
      .select({ id: instanceRetentionConfig.id })
      .from(instanceRetentionConfig)
      .where(isNull(instanceRetentionConfig.companyId))
      .limit(1);

    const now = new Date();

    if (existing.length === 0) {
      const [created] = await db
        .insert(instanceRetentionConfig)
        .values({
          companyId: null,
          succeededRunRetentionHours:
            updates.succeededRunRetentionHours ?? DEFAULT_SUCCEEDED_RETENTION_HOURS,
          failedRunRetentionHours:
            updates.failedRunRetentionHours ?? DEFAULT_FAILED_RETENTION_HOURS,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          succeededRunRetentionHours: instanceRetentionConfig.succeededRunRetentionHours,
          failedRunRetentionHours: instanceRetentionConfig.failedRunRetentionHours,
        });
      res.json(created);
    } else {
      const [updated] = await db
        .update(instanceRetentionConfig)
        .set({ ...updates, updatedAt: now })
        .where(isNull(instanceRetentionConfig.companyId))
        .returning({
          succeededRunRetentionHours: instanceRetentionConfig.succeededRunRetentionHours,
          failedRunRetentionHours: instanceRetentionConfig.failedRunRetentionHours,
        });
      res.json(updated);
    }
  });

  return router;
}
