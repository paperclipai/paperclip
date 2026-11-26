import { Router, type RequestHandler } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden, notFound } from "../errors.js";
import { agentService } from "../services/agents.js";
import type { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { issueService } from "../services/issues.js";
import { ensureOnboardingChat, startOnboardingGreeting } from "../services/onboarding-chat.js";
import { assertCompanyAccess } from "./authz.js";

export function onboardingChatRoutes(db: Db, heartbeat: Pick<ReturnType<typeof heartbeatService>, "wakeup">) {
  const router = Router();
  const handle = (greeting: boolean): RequestHandler => async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board" || !req.actor.userId) throw forbidden("Board user access required");
    if (!(await instanceSettingsService(db).getExperimental()).enableAgentChat) throw notFound("Agent Chat is disabled");
    const resolved = await agentService(db).resolveByReference(companyId, req.params.agentRef as string);
    if (!resolved.agent || resolved.ambiguous) throw notFound("Agent not found");
    const agent = resolved.agent;
    const userId = req.actor.userId;
    if (!greeting) {
      res.json(await ensureOnboardingChat(db, { companyId, agentId: agent.id, agentName: agent.name, userId }));
      return;
    }
    const issue = await issueService(db).getConversation(companyId, agent.id, userId);
    if (!issue) throw notFound("Conversation not found");
    res.json({ started: await startOnboardingGreeting(db, issue, userId, heartbeat.wakeup) });
  };
  router.post("/companies/:companyId/chats/:agentRef/onboarding", handle(false));
  router.post("/companies/:companyId/chats/:agentRef/onboarding/greeting", handle(true));
  return router;
}
