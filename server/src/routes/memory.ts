import type { Request, Response } from "express";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { ingestMemorySchema, searchMemorySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { agentService, memoryService } from "../services/index.js";
import { resolveCoreTrustPreset } from "../services/trust-preset-resolver.js";
import { notFound } from "../errors.js";

function parseTagsQuery(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item)).filter((item) => item.length > 0);
  }
  if (typeof value === "string" && value.length > 0) {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return undefined;
}

export function memoryRoutes(db: Db) {
  const router = Router();
  const svc = memoryService(db);
  const agentsSvc = agentService(db);

  /**
   * The record_context issue-thread interaction (propose -> accept) already
   * runs an agent through `assertAgentIssueMutationAllowed` and
   * `assertLowTrustControlPlaneDenied` before it writes a memory row. This
   * raw route has no issue context to gate on, so an agent hitting it
   * directly would otherwise bypass those checks entirely. Deny any agent
   * actor whose trust does not resolve to the default "standard" preset —
   * that covers both an explicit low-trust review boundary and any
   * unresolvable/denied policy, since neither can be trusted to write
   * memory without an issue-scoped review path. Board/user/system/script
   * actors are unaffected.
   */
  async function assertLowTrustAgentDeniedForMemoryMutation(req: Request, res: Response, companyId: string) {
    if (req.actor.type !== "agent") return false;
    const agentId = req.actor.agentId;
    if (!agentId) {
      res.status(403).json({ error: "Agent authentication required" });
      return true;
    }
    const agent = await agentsSvc.getById(agentId);
    if (!agent || agent.companyId !== companyId) {
      res.status(403).json({ error: "Agent key cannot access another company" });
      return true;
    }
    const resolution = resolveCoreTrustPreset({
      companyId,
      agent: { companyId: agent.companyId, permissions: agent.permissions },
    });
    if (resolution.kind !== "standard") {
      res.status(403).json({ error: "Low-trust actors cannot use this control-plane surface" });
      return true;
    }
    return false;
  }

  router.post("/companies/:companyId/memory", validate(ingestMemorySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (await assertLowTrustAgentDeniedForMemoryMutation(req, res, companyId)) return;
    const actor = getActorInfo(req);
    const entry = await svc.ingest(companyId, req.body, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
    });
    res.status(201).json(entry);
  });

  router.get("/companies/:companyId/memory", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limitRaw = req.query.limit !== undefined ? Number(req.query.limit) : undefined;

    const result = await svc.browse({
      companyId,
      projectId: (req.query.projectId as string | undefined) ?? null,
      goalId: (req.query.goalId as string | undefined) ?? null,
      key: req.query.key as string | undefined,
      tags: parseTagsQuery(req.query.tags),
      limit: limitRaw,
    });
    res.json(result);
  });

  router.get("/companies/:companyId/memory/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const parsed = searchMemorySchema.parse({
      query: req.query.query as string | undefined,
      projectId: (req.query.projectId as string | undefined) ?? null,
      goalId: (req.query.goalId as string | undefined) ?? null,
      key: req.query.key as string | undefined,
      tags: parseTagsQuery(req.query.tags),
      limit: req.query.limit !== undefined ? Number(req.query.limit) : undefined,
    });

    const result = await svc.search(companyId, parsed);
    res.json(result);
  });

  router.get("/companies/:companyId/memory/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const id = req.params.id as string;
    const entry = await svc.get(companyId, id);
    if (!entry) throw notFound("Memory entry not found");
    res.json(entry);
  });

  router.delete("/companies/:companyId/memory/:id", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (await assertLowTrustAgentDeniedForMemoryMutation(req, res, companyId)) return;
    const actor = getActorInfo(req);
    const id = req.params.id as string;
    const existing = await svc.get(companyId, id);
    if (!existing) throw notFound("Memory entry not found");
    await svc.forget(companyId, id, {
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
    });
    res.status(204).end();
  });

  return router;
}
