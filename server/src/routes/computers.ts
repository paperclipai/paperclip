import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { agents, environmentLeases, environments, issues, type Db } from "@paperclipai/db";
import { resolvePaperclipRunnerIdleTimeoutMs } from "@paperclipai/adapter-utils";
import { computerService, ComputerError } from "../modules/computers/index.js";
import { computerOwnerFromLease } from "../services/computer-environment-driver.js";
import { environmentService } from "../services/environments.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { logActivity } from "../services/activity-log.js";
import { conflict, notFound, unprocessable } from "../errors.js";
import { assertBoard, getActorInfo, getAccessibleResource } from "./authz.js";

const ownerSchema = z.object({ computerId: z.string().uuid(), ownerId: z.string().uuid(), generation: z.number().int().positive() }).strict();
const scopeSchema = z.object({ environmentId: z.string().uuid() });
const presenceSchema = scopeSchema.extend({ owner: ownerSchema }).strict();

export function computerRoutes(db: Db, computers = computerService(db)) {
  const router = Router();
  const settings = instanceSettingsService(db);
  const envs = environmentService(db);

  router.use("/issues/:issueId/computer", async (req, res, next) => {
    assertBoard(req);
    if (!z.string().uuid().safeParse(req.params.issueId).success) throw notFound("Task not found");
    const [row] = await db.select().from(issues).where(eq(issues.id, req.params.issueId)).limit(1);
    const issue = await getAccessibleResource(req, res, row, "Task not found");
    if (!issue) return;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (!(await settings.getExperimental()).enableBoatEnvironments && !req.path.endsWith("/disconnect")) {
      if (req.method === "GET") { res.json(null); return; }
      throw unprocessable("Boat environments are disabled.");
    }
    const [lease] = await db.select().from(environmentLeases)
      .where(and(eq(environmentLeases.companyId, issue.companyId), eq(environmentLeases.issueId, issue.id), eq(environmentLeases.provider, "boat")))
      .orderBy(desc(environmentLeases.updatedAt)).limit(1);
    const [agent] = issue.assigneeAgentId ? await db.select().from(agents)
      .where(and(eq(agents.companyId, issue.companyId), eq(agents.id, issue.assigneeAgentId))).limit(1) : [];
    const environmentId = lease?.environmentId ?? agent?.defaultEnvironmentId ?? (await settings.get()).defaultEnvironmentId;
    const [environment] = environmentId ? await db.select().from(environments).where(eq(environments.id, environmentId)).limit(1) : [];
    if (!environment || environment.driver !== "computer" || environment.metadata?.computerCompanyId !== issue.companyId || environment.status !== "active") {
      if (req.method === "GET") { res.json(null); return; }
      throw notFound("Computer not available for this task");
    }
    res.locals.computer = { environment, issue, lease, agent };
    next();
  });

  router.get("/issues/:issueId/computer", async (_req, res) => {
    const { environment } = res.locals.computer;
    res.json({ environmentId: environment.id, name: environment.name });
  });

  router.post("/issues/:issueId/computer/connect", async (req, res) => {
    const input = scopeSchema.strict().parse(req.body);
    const { environment, issue, agent } = res.locals.computer;
    if (input.environmentId !== environment.id) throw notFound("Computer not available for this task");
    const actor = getActorInfo(req);
    const viewer = await computers.connect({ companyId: issue.companyId, environmentId: environment.id,
      userId: actor.actorId, idleTimeoutMs: resolvePaperclipRunnerIdleTimeoutMs(environment.config.runnerIdleTimeoutMs ?? agent?.adapterConfig?.idleTimeoutMs) });
    await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId,
      action: "computer.connected", entityType: "environment", entityId: environment.id, details: { issueId: issue.id } });
    res.json(viewer);
  });

  router.post("/issues/:issueId/computer/presence", async (req, res) => {
    const input = presenceSchema.parse(req.body);
    const { environment, issue } = res.locals.computer;
    if (input.environmentId !== environment.id) throw notFound("Computer not available for this task");
    res.json(await computers.renewViewer({ companyId: issue.companyId, environmentId: environment.id,
      owner: input.owner, userId: getActorInfo(req).actorId }));
  });

  router.post("/issues/:issueId/computer/disconnect", async (req, res) => {
    const input = presenceSchema.parse(req.body);
    const { environment, issue } = res.locals.computer;
    if (input.environmentId !== environment.id) throw notFound("Computer not available for this task");
    const actor = getActorInfo(req);
    await computers.disconnectViewer({ companyId: issue.companyId, environmentId: environment.id,
      owner: input.owner, userId: actor.actorId });
    await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId,
      action: "computer.disconnected", entityType: "environment", entityId: environment.id, details: { issueId: issue.id } });
    res.status(204).end();
  });

  router.post("/issues/:issueId/computer/preview", async (req, res) => {
    const input = scopeSchema.extend({ port: z.number().int().min(1024).max(65535) }).strict().parse(req.body);
    const { environment, issue, lease } = res.locals.computer;
    if (input.environmentId !== environment.id) throw notFound("Computer not available for this task");
    const current = lease ? await envs.getLeaseById(lease.id) : null;
    if (!current) throw conflict("Start a dev server in this task before opening its preview.");
    const result = await computers.preview({ companyId: issue.companyId, environmentId: environment.id,
      owner: computerOwnerFromLease(current), port: input.port });
    const actor = getActorInfo(req);
    await logActivity(db, { companyId: issue.companyId, actorType: actor.actorType, actorId: actor.actorId,
      action: "computer.preview_opened", entityType: "environment", entityId: environment.id, details: { issueId: issue.id, port: input.port } });
    res.json(result);
  });

  router.use((error: unknown, _req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    if (!(error instanceof ComputerError)) return next(error);
    res.status(error.code === "conflict" ? 409 : error.code === "invalid" ? 422 : error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : 502).json({ error: error.message, code: error.code });
  });
  return router;
}
