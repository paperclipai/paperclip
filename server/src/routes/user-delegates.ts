import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { setUserDelegateSchema } from "@paperclipai/shared";
import { forbidden, unauthorized } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/activity-log.js";
import { listUserDelegateActions, userDelegateService } from "../services/user-delegates.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function userDelegateRoutes(db: Db) {
  const router = Router();
  const delegates = userDelegateService(db);

  /** Only the signed-in person manages their own delegate; a delegate never can. */
  function personUserId(req: Request) {
    if (req.actor.type !== "board" || !req.actor.userId) throw unauthorized("Board user context required");
    if (req.actor.source === "delegate") {
      throw forbidden("A delegate cannot change who the person's delegate is", { code: "user_delegate_self_management" });
    }
    return req.actor.userId;
  }

  async function logDelegateChange(req: Request, companyId: string, action: string, entityId: string, details: Record<string, unknown>) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "user_delegate",
      entityId,
      details,
    });
  }

  router.get("/companies/:companyId/users/me/delegate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = personUserId(req);
    res.json({ delegate: await delegates.getActive(companyId, userId), actions: listUserDelegateActions() });
  });

  router.put("/companies/:companyId/users/me/delegate", validate(setUserDelegateSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = personUserId(req);
    const { delegate, previous } = await delegates.set(companyId, userId, req.body.agentId);
    await logDelegateChange(req, companyId, "user_delegate.set", delegate.id, {
      userId,
      delegateAgentId: delegate.delegateAgentId,
      previousDelegateAgentId: previous?.delegateAgentId ?? null,
    });
    res.json({ delegate, actions: listUserDelegateActions() });
  });

  router.delete("/companies/:companyId/users/me/delegate", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const userId = personUserId(req);
    const revoked = await delegates.revoke(companyId, userId);
    if (revoked) {
      await logDelegateChange(req, companyId, "user_delegate.revoked", revoked.id, {
        userId,
        delegateAgentId: revoked.delegateAgentId,
      });
    }
    res.json({ delegate: null, actions: listUserDelegateActions() });
  });

  /** For an agent: the people who named it as their delegate in this company. */
  router.get("/companies/:companyId/user-delegations/mine", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "agent" || !req.actor.agentId) throw forbidden("Agent access required");
    res.json({ delegations: await delegates.listActiveForAgent(companyId, req.actor.agentId), actions: listUserDelegateActions() });
  });

  return router;
}
