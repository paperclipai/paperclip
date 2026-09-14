import type { Request } from "express";
import { activityLog, type Db } from "@paperclipai/db";
import type { CreateRuntimeService, RegisterRuntimeService } from "@paperclipai/shared";
import { authorizeRuntimeService } from "./authorization.js";
import type { RuntimeServiceManager, RuntimeServicePlacement } from "./manager.js";
import { assertAuthenticated, assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { forbidden } from "../../errors.js";

export interface RuntimeServiceDependencies {
  manager: RuntimeServiceManager;
  resolvePlacement(req: Request, companyId: string, input: CreateRuntimeService): Promise<RuntimeServicePlacement>;
}

/** One authorization and placement path for the board, MCP, and native tools. */
export function createRuntimeServiceOperations(db: Db, dependencies: RuntimeServiceDependencies) {
  const { manager } = dependencies;
  async function scope(req: Request, companyId: string, serviceId: string, mutation = false) {
    assertCompanyAccess(req, companyId);
    const service = await manager.get(companyId, serviceId);
    const authorization = await authorizeRuntimeService(db, req, { companyId, serviceId, issueId: service.issueId, mutation });
    return { service, ...authorization };
  }
  return {
    async dataDeletionReview(req: Request, companyId: string, serviceId: string) {
      assertAuthenticated(req); assertBoard(req);
      await scope(req, companyId, serviceId);
      return manager.dataDeletionReview(companyId, serviceId);
    },
    async deleteData(req: Request, companyId: string, serviceId: string, input: Parameters<RuntimeServiceManager["deleteData"]>[3]) {
      assertAuthenticated(req); assertBoard(req);
      const { actor } = await scope(req, companyId, serviceId, true);
      return manager.deleteData(companyId, serviceId, actor, input);
    },
    async companyPolicy(req: Request, companyId: string) {
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      await authorizeRuntimeService(db, req, { companyId });
      return manager.companyPolicy(companyId);
    },
    async updateCompanyPolicy(req: Request, companyId: string, input: Parameters<RuntimeServiceManager["updateCompanyPolicy"]>[2]) {
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const authorization = await authorizeRuntimeService(db, req, { companyId, mutation: true });
      return manager.updateCompanyPolicy(companyId, authorization.actor, input);
    },
    async list(req: Request, companyId: string, issueId?: string) {
      const authorization = await authorizeRuntimeService(db, req, { companyId, issueId });
      return manager.list(companyId, authorization.companyWide ? issueId : authorization.issueId!);
    },
    async create(req: Request, companyId: string, input: CreateRuntimeService) {
      const authorization = await authorizeRuntimeService(db, req, { companyId, issueId: input.issueId, mutation: true, creating: true });
      if (req.actor.type !== "board" && Object.values(input.env).some((binding) => binding.type === "secret_ref")) {
        throw forbidden("An operator must authorize secret bindings for this service");
      }
      const resolvedInput = { ...input, issueId: authorization.issueId ?? undefined };
      const placement = await dependencies.resolvePlacement(req, companyId, resolvedInput);
      return manager.create(companyId, authorization.actor, resolvedInput, placement);
    },
    async register(req: Request, companyId: string, input: RegisterRuntimeService) {
      const authorization = await authorizeRuntimeService(db, req, { companyId, issueId: input.issueId, mutation: true, creating: true });
      if (req.actor.type !== "agent" || !req.actor.runId) throw forbidden("Existing process registration requires an authenticated active agent run");
      if (Object.values(input.env).some((binding) => binding.type === "secret_ref")) throw forbidden("An operator must authorize secret bindings for this service");
      const { sourcePid, ...spec } = input;
      const resolvedInput = { ...spec, issueId: authorization.issueId ?? undefined };
      const placement = await dependencies.resolvePlacement(req, companyId, resolvedInput);
      return manager.register(companyId, authorization.actor, { ...resolvedInput, sourcePid }, placement);
    },
    async inspect(req: Request, companyId: string, serviceId: string) {
      return (await scope(req, companyId, serviceId)).service;
    },
    async storage(req: Request, companyId: string, serviceId: string, refresh = false) {
      assertAuthenticated(req);
      assertBoard(req);
      const { actor } = await scope(req, companyId, serviceId, refresh);
      if (!refresh) return manager.storage(companyId, serviceId);
      const result = await manager.refreshStorage(companyId, serviceId);
      await db.insert(activityLog).values({ companyId, actorType: "user", actorId: actor.id,
        action: "runtime_service.storage_checked", entityType: "runtime_service_allocation", entityId: result.allocationId,
        details: { serviceId, checkedAt: result.usage.checkedAt, status: result.usage.status } });
      return result;
    },
    async attachTask(req: Request, companyId: string, serviceId: string, input: Parameters<RuntimeServiceManager["attachTask"]>[3]) {
      assertAuthenticated(req);
      assertBoard(req);
      const authorization = await scope(req, companyId, serviceId, true);
      await authorizeRuntimeService(db, req, { companyId, issueId: input.issueId, mutation: true });
      return manager.attachTask(companyId, serviceId, authorization.actor, input);
    },
    async detachTask(req: Request, companyId: string, serviceId: string, input: Parameters<RuntimeServiceManager["detachTask"]>[3]) {
      assertAuthenticated(req);
      assertBoard(req);
      const authorization = await scope(req, companyId, serviceId, true);
      await authorizeRuntimeService(db, req, { companyId, issueId: input.issueId, mutation: true });
      return manager.detachTask(companyId, serviceId, authorization.actor, input);
    },
    async control(req: Request, companyId: string, serviceId: string, input: Parameters<RuntimeServiceManager["control"]>[3]) {
      const authorization = await scope(req, companyId, serviceId, true);
      return manager.control(companyId, serviceId, authorization.actor, input);
    },
    async updatePolicy(req: Request, companyId: string, serviceId: string, input: Parameters<RuntimeServiceManager["updatePolicy"]>[3]) {
      const authorization = await scope(req, companyId, serviceId, true);
      return manager.updatePolicy(companyId, serviceId, authorization.actor, input);
    },
    async logs(req: Request, companyId: string, serviceId: string) {
      await scope(req, companyId, serviceId);
      return { text: await manager.logs(companyId, serviceId) };
    },
    async environment(req: Request, companyId: string, serviceId: string) {
      assertBoard(req);
      await scope(req, companyId, serviceId, true);
      const { service } = await manager.getRecord(companyId, serviceId);
      return { revision: service.revision, env: service.spec.env };
    },
    async updateEnvironment(req: Request, companyId: string, serviceId: string, input: Parameters<RuntimeServiceManager["updateEnvironment"]>[3]) {
      assertBoard(req);
      const authorization = await scope(req, companyId, serviceId, true);
      return manager.updateEnvironment(companyId, serviceId, authorization.actor, input);
    },
    async activity(req: Request, companyId: string, serviceId: string, visible: boolean) {
      await scope(req, companyId, serviceId, true);
      await manager.activity(companyId, serviceId, visible);
    },
  };
}

export type RuntimeServiceOperations = ReturnType<typeof createRuntimeServiceOperations>;
