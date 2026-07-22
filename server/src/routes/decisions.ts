import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { decisionInputsSchema, decisionOptionsSchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { decisionService } from "../services/decisions.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getActorInfo } from "./authz.js";

const createSchema = z.object({
  title: z.string().trim().min(1).max(500),
  body: z.string().max(100_000),
  ruleKey: z.string().trim().max(240).nullable().optional(),
  options: decisionOptionsSchema,
  inputs: decisionInputsSchema.nullable().optional(),
  expiresAt: z.coerce.date().optional(),
  idempotencyKey: z.string().trim().min(1).max(500).nullable().optional(),
  continuationPolicy: z.enum(["none", "wake_origin_agent"]).optional(),
  metadata: z.record(z.unknown()).optional(),
}).strict();
const bundleSchema = z.object({ title: z.string().trim().min(1).max(500), summary: z.string().max(100_000), decisions: z.array(createSchema).min(1).max(50) }).strict();
const decideSchema = z.object({ optionId: z.string().trim().min(1).max(120), inputValues: z.record(z.string().max(20_000)).optional(), idempotencyKey: z.string().trim().min(1).max(500).nullable().optional() }).strict();
const dismissSchema = z.object({ reason: z.string().max(20_000).nullable().optional() }).strict();

function agentContext(req: Parameters<typeof getActorInfo>[0]) {
  if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId) return null;
  return { agentId: req.actor.agentId, runId: req.actor.runId };
}

function boardUserId(req: Parameters<typeof getActorInfo>[0]) {
  assertBoard(req);
  return req.actor.userId ?? "local-implicit-board";
}

export function decisionRoutes(db: Db) {
  const router = Router();
  const svc = decisionService(db);
  router.post("/companies/:companyId/decisions", validate(createSchema), async (req, res) => {
    const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const agent = agentContext(req); if (!agent) { res.status(403).json({ error: "Agent run context required" }); return; }
    res.status(201).json(await svc.create({ companyId, actor: req.actor, ...agent, ...req.body }));
  });
  router.post("/companies/:companyId/decision-bundles", validate(bundleSchema), async (req, res) => {
    const companyId = req.params.companyId as string; assertCompanyAccess(req, companyId);
    const agent = agentContext(req); if (!agent) { res.status(403).json({ error: "Agent run context required" }); return; }
    res.status(201).json(await svc.createBundle({ companyId, actor: req.actor, ...agent, ...req.body }));
  });
  router.get("/companies/:companyId/decisions", async (req, res) => {
    const companyId = req.params.companyId as string; assertBoard(req); assertCompanyAccess(req, companyId);
    const query = z.object({ status: z.enum(["open", "decided", "expired", "cancelled"]).optional(), bundleId: z.string().uuid().optional(), targetIssueId: z.string().uuid().optional(), originAgentId: z.string().uuid().optional(), limit: z.coerce.number().int().positive().max(100).optional() }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid decision filters", details: query.error.flatten() }); return; }
    res.json(await svc.list(companyId, query.data));
  });
  router.get("/decisions/:id", async (req, res) => {
    assertBoardOrAgent(req); const decision = await svc.get(req.params.id as string);
    if (!decision) { res.status(404).json({ error: "Decision not found" }); return; }
    assertCompanyAccess(req, decision.companyId);
    if (req.actor.type === "agent" && req.actor.agentId !== decision.originAgentId) { res.status(403).json({ error: "Only the origin agent may read this decision" }); return; }
    res.json(await svc.outcome(decision.id));
  });
  router.post("/decisions/:id/decide", validate(decideSchema), async (req, res) => {
    const userId = boardUserId(req); const decision = await svc.get(req.params.id as string);
    if (!decision) { res.status(404).json({ error: "Decision not found" }); return; } assertCompanyAccess(req, decision.companyId);
    res.json(await svc.decide({ id: decision.id, decidedByUserId: userId, userActor: req.actor, ...req.body }));
  });
  router.post("/decisions/:id/dismiss", validate(dismissSchema), async (req, res) => {
    const userId = boardUserId(req); const decision = await svc.get(req.params.id as string);
    if (!decision) { res.status(404).json({ error: "Decision not found" }); return; } assertCompanyAccess(req, decision.companyId);
    res.json(await svc.dismiss(decision.id, userId, req.actor, req.body.reason));
  });
  router.post("/decisions/:id/cancel", async (req, res) => {
    assertBoardOrAgent(req); const decision = await svc.get(req.params.id as string);
    if (!decision) { res.status(404).json({ error: "Decision not found" }); return; } assertCompanyAccess(req, decision.companyId);
    const actor = getActorInfo(req); res.json(await svc.cancel(decision.id, { actorType: actor.actorType, actorId: actor.actorId, runId: actor.runId }));
  });
  return router;
}
