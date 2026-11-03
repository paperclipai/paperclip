import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { agentObservabilityRevisionSchema, updateAgentObservabilitySchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { canManageAiConnections } from "./ai-connections.js";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { agentObservabilityService } from "../services/agent-observability.js";
import { testAgentObservability } from "../services/agent-observability-test.js";

export function agentObservabilityRoutes(db: Db, options: { deploymentMode?: string; deploymentExposure?: string } = {}) {
  const router = Router(), service = agentObservabilityService(db);
  const path = "/companies/:companyId/observability";
  async function access(req: Request, manage: boolean) {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId); assertBoard(req);
    const canManage = await canManageAiConnections(db, req, companyId);
    if (manage && !canManage) throw forbidden("Manage connections permission is required");
    return { companyId, canManage, userId: getActorInfo(req).actorId };
  }
  router.get("/companies/:companyId/observability", async (req, res) => {
    const { companyId, canManage } = await access(req, false);
    res.json({ canManage, settings: canManage ? await service.settings(companyId) : null });
  });
  router.use(path, async (req, _res, next) => { await access(req, true); next(); });
  router.put("/companies/:companyId/observability", validate(updateAgentObservabilitySchema), async (req, res) => {
    const { companyId, userId } = await access(req, true);
    res.json({ canManage: true, settings: await service.configure(companyId, userId, req.body) });
  });
  router.delete("/companies/:companyId/observability", validate(agentObservabilityRevisionSchema), async (req, res) => {
    const { companyId, userId } = await access(req, true);
    await service.remove(companyId, userId, req.body.expectedRevision);
    res.json({ canManage: true, settings: null });
  });
  router.post("/companies/:companyId/observability/test", validate(agentObservabilityRevisionSchema), async (req, res) => {
    const { companyId, userId } = await access(req, true);
    const revision = req.body.expectedRevision as string;
    const resolved = await service.resolve(companyId, { forTest: true, expectedRevision: revision, userId });
    const receipt = await testAgentObservability({ companyId, revision, resolved,
      allowPrivateNetwork: options.deploymentMode !== "authenticated" || options.deploymentExposure !== "public" });
    res.json(await service.recordTest(companyId, userId, receipt));
  });
  return router;
}
