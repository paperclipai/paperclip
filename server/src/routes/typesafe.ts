import { Router } from "express";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { typesafeAskSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { executeTypesafeAsk } from "../services/connectors/typesafe.js";
import { assertCompanyAccess } from "./authz.js";

export function typesafeRoutes(db: Db, fetchImpl: typeof fetch = fetch) {
  const router = Router();

  router.post(
    "/companies/:companyId/typesafe/ask",
    validate(typesafeAskSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      // Access is an agent's connection install; a board user has none to resolve.
      if (req.actor.type !== "agent" || !req.actor.agentId)
        throw forbidden("Only agents can ask TypeSafe");
      // The middleware copies the run header unverified; a key alone must not reach the vault.
      const runId = req.actor.runId;
      const [run] = runId
        ? await db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(
              and(
                eq(heartbeatRuns.id, runId),
                eq(heartbeatRuns.companyId, companyId),
                eq(heartbeatRuns.agentId, req.actor.agentId),
                eq(heartbeatRuns.status, "running"),
              ),
            )
        : [];
      if (!run) throw forbidden("TypeSafe needs an active run of this agent");
      res.json(
        await executeTypesafeAsk(
          db,
          {
            companyId,
            agentId: req.actor.agentId,
            runId: run.id,
            issueId: null,
          },
          req.body,
          fetchImpl,
        ),
      );
    },
  );

  return router;
}
