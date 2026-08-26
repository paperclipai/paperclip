import { Router, type NextFunction, type Request, type Response } from "express";
import type { Db } from "@paperclipai/db";
import { replaceGovernancePolicySchema, restoreGovernancePolicyRevisionSchema } from "@paperclipai/shared";
import { ZodError } from "zod";
import { forbidden, HttpError, unprocessable } from "../errors.js";
import { accessService } from "../services/access.js";
import { companyGovernancePolicyService } from "../services/company-governance-policy.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

/** Board-only configuration surface. Agent credentials may read their company
 * policy metadata but never create, replace, or restore an overlay. */
export function companyGovernancePolicyRoutes(db: Db) {
  const router = Router();
  const access = accessService(db);
  const policies = companyGovernancePolicyService(db);

  function assertRead(req: Request, companyId: string) {
    if (req.actor.type === "none") throw new HttpError(401, "Authentication required");
    if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
      throw forbidden("Agent key cannot access another company", { code: "governance_policy_company_boundary_denied" });
    }
    assertCompanyAccess(req, companyId);
  }

  async function assertBoardAdmin(req: Request, companyId: string) {
    assertRead(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Board governance authority required", { code: "governance_policy_board_required" });
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    if (await access.canUser(companyId, req.actor.userId, "users:manage_permissions")) return;
    throw forbidden("Board governance authority required", { code: "governance_policy_board_required" });
  }

  function validate(req: Request, _res: Response, next: NextFunction) {
    try {
      req.body = replaceGovernancePolicySchema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        next(unprocessable("Invalid governance policy document", {
          code: "governance_policy_validation_failed", issues: error.issues,
        }));
        return;
      }
      next(error);
    }
  }

  router.get("/companies/:companyId/governance-policy", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertRead(req, companyId);
    const readback = await policies.get(companyId);
    if (req.actor.type === "agent") {
      // An agent needs provenance for its own run, not the board's complete
      // policy text or historical configuration. Keep policy content and peer
      // bindings board-visible only.
      const metadata = (revision: typeof readback.active) => revision && ({
        id: revision.id,
        revision: revision.revision,
        sha256: revision.sha256,
        createdAt: revision.createdAt,
      });
      res.json({
        active: metadata(readback.active),
        history: readback.history.map(metadata),
        targets: readback.targets.filter((target) => target.agentId === req.actor.agentId),
        drift: readback.drift,
      });
      return;
    }
    res.json(readback);
  });

  router.put("/companies/:companyId/governance-policy", validate, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardAdmin(req, companyId);
    const actor = getActorInfo(req);
    const { expectedRevision, ...policy } = req.body;
    res.json(await policies.replace({
      companyId,
      expectedRevision,
      policy,
      activity: { actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId },
    }));
  });

  router.post("/companies/:companyId/governance-policy/revisions/:revisionId/restore", async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardAdmin(req, companyId);
    const parsed = restoreGovernancePolicyRevisionSchema.safeParse(req.body);
    if (!parsed.success) {
      throw unprocessable("expectedRevision must be a positive integer", {
        code: "governance_policy_validation_failed", issues: parsed.error.issues,
      });
    }
    const actor = getActorInfo(req);
    res.json(await policies.restore({
      companyId,
      revisionId: req.params.revisionId as string,
      expectedRevision: parsed.data.expectedRevision,
      activity: { actorType: actor.actorType, actorId: actor.actorId, agentId: actor.agentId, runId: actor.runId },
    }));
  });

  return router;
}
