import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { setAgentAvatarSchema } from "@paperclipai/shared";
import { z } from "zod";
import type { StorageService } from "../storage/types.js";
import { forbidden } from "../errors.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { accessService } from "../services/access.js";
import { setAgentProfileAvatar } from "../services/agent-profile-avatar.js";

export function agentProfileAvatarRoutes(db: Db, storage: StorageService) {
  const router = Router();
  router.put("/companies/:companyId/agents/:agentId/avatar", async (req, res) => {
    const companyId = z.uuid().parse(req.params.companyId);
    const agentId = z.uuid().parse(req.params.agentId);
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      if (req.actor.keyScope?.kind === "task_bridge" || req.actor.keyScope?.kind === "skill_test") {
        throw forbidden("Task-scoped credentials cannot update agent profiles");
      }
      if (req.actor.agentId !== agentId) throw forbidden("Agents can update only their own avatar");
    } else if (req.actor.type !== "board" || req.actor.memberships?.find(m => m.companyId === companyId)?.membershipRole === "viewer") {
      throw forbidden("Operator or agent access required");
    }
    if (req.actor.type === "board") {
      const decision = await accessService(db).decide({
        actor: req.actor, action: "agent_config:update",
        resource: { type: "agent", companyId, agentId },
      });
      if (!decision.allowed) throw forbidden(decision.explanation);
    }
    const actor = getActorInfo(req);
    res.json(await setAgentProfileAvatar(db, storage, companyId, agentId, setAgentAvatarSchema.parse(req.body), actor));
  });
  return router;
}
