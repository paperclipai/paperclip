import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { pendingResponseService } from "../services/pending-responses.js";
import { assertCompanyAccess } from "./authz.js";

const createPendingResponseSchema = z.object({
  waitingAgentId: z.string().uuid(),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
  expiresInMinutes: z.number().int().positive().optional(),
});

export function pendingResponseRoutes(db: Db) {
  const router = Router();
  const svc = pendingResponseService(db);

  router.post(
    "/companies/:companyId/pending-responses",
    validate(createPendingResponseSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const { waitingAgentId, channelId, threadTs, expiresInMinutes } = req.body as z.infer<
        typeof createPendingResponseSchema
      >;

      const expiresAt = expiresInMinutes
        ? new Date(Date.now() + expiresInMinutes * 60 * 1000)
        : undefined;

      const row = await svc.create({
        companyId,
        waitingAgentId,
        channelId,
        threadTs,
        expiresAt,
      });

      res.status(201).json({ id: row.id });
    },
  );

  return router;
}
