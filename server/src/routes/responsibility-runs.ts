import { Router, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { authorizationDeniedDetails, issueReadSqlCondition, projectReadSqlCondition } from "../services/authorization.js";
import { accessService } from "../services/index.js";
import { responsibilityService, type ResponsibilityReadScope } from "../services/responsibilities.js";
import { clampRecentRunsLimit, responsibilityRunsService } from "../services/responsibility-runs.js";
import { getAccessibleResource } from "./authz.js";

const NOT_FOUND = "Responsibility not found";

/**
 * The recent agent runs on the work under a responsibility (experimental
 * `enableResponsibilities`), for its page. Same access as reading the
 * responsibility; a read, so nothing is logged.
 */
export function responsibilityRunRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const svc = responsibilityRunsService(db);
  const responsibilitiesSvc = responsibilityService(db);

  async function readScope(req: Request): Promise<ResponsibilityReadScope> {
    const [issueReadCondition, projectReadCondition] = await Promise.all([
      issueReadSqlCondition(db, req.actor),
      projectReadSqlCondition(db, req.actor),
    ]);
    return { issueReadCondition, projectReadCondition };
  }

  /** The detail route's read rule: company access, board or agent, and agents inside the company-scope boundary. */
  async function loadForRead(req: Request, res: Response) {
    const row = await getAccessibleResource(req, res, responsibilitiesSvc.getById(req.params.id as string), NOT_FOUND);
    if (!row) return null;
    if (req.actor.type !== "board" && req.actor.type !== "agent") throw forbidden("Board or agent access required");
    if (req.actor.type === "agent") {
      const decision = await access.decide({ actor: req.actor, action: "company_scope:read", resource: { type: "company", companyId: row.companyId } });
      if (!decision.allowed) {
        throw forbidden("Responsibilities are outside this agent's authorization boundary", authorizationDeniedDetails(decision));
      }
    }
    return row;
  }

  router.get("/responsibilities/:id/runs", async (req, res) => {
    await svc.assertEnabled();
    const row = await loadForRead(req, res);
    if (!row) return;
    res.json(await svc.recent(row, await readScope(req), clampRecentRunsLimit(req.query.limit)));
  });

  return router;
}
