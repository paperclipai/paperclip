import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createAgentMemorySchema,
  recallAgentMemorySchema,
  correctAgentMemorySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  agentMemoryConsolidationService,
  agentMemoryService,
  agentService,
  logActivity,
} from "../services/index.js";
import { forbidden, notFound } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import type { MemoryActor } from "../services/agent-memories.js";

export function agentMemoryRoutes(db: Db) {
  const router = Router();
  const agents = agentService(db);
  const svc = agentMemoryService(db);
  const consolidation = agentMemoryConsolidationService(db);

  /**
   * Resolve the target agent, enforce company access, and enforce that an agent
   * actor may only touch its own memory. Returns the resolved companyId + a
   * MemoryActor for attribution and activity logging.
   */
  async function resolveContext(req: Request, agentId: string): Promise<{ companyId: string; actor: MemoryActor }> {
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);

    const info = getActorInfo(req);
    if (info.actorType === "agent" && info.agentId !== agentId) {
      throw forbidden("Agents can only access their own memory");
    }
    return { companyId: agent.companyId, actor: { actorType: info.actorType, actorId: info.actorId } };
  }

  function firstQueryString(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
    return undefined;
  }

  // List memories (board + agent). Board may include forgotten with ?includeForgotten=1.
  router.get("/agents/:agentId/memories", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const includeForgotten = actor.actorType === "user" && firstQueryString(req.query.includeForgotten) === "1";
    res.json(await svc.list(companyId, agentId, { includeForgotten }));
  });

  // Rendered MEMORY.md view (board + agent).
  router.get("/agents/:agentId/memories/markdown", async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.type("text/markdown").send(await svc.renderMarkdown(companyId, agentId));
  });

  // Write a memory (board + owning agent).
  router.post("/agents/:agentId/memories", validate(createAgentMemorySchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    await svc.assertProvenanceInScope(companyId, agentId, req.body);
    const memory = await svc.write(companyId, agentId, req.body, actor);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent_memory_created",
      entityType: "agent_memory",
      entityId: memory.id,
      agentId,
      details: { type: memory.type, title: memory.title },
    });
    res.status(201).json(memory);
  });

  // Recall memories (bumps recall stats) — primarily for agents during a run.
  router.post("/agents/:agentId/memories/recall", validate(recallAgentMemorySchema), async (req, res) => {
    const agentId = req.params.agentId as string;
    const { companyId } = await resolveContext(req, agentId);
    res.json(await svc.recall(companyId, agentId, req.body));
  });

  // Forget a memory (board + owning agent).
  router.post("/agents/:agentId/memories/:memoryId/forget", async (req, res) => {
    const agentId = req.params.agentId as string;
    const memoryId = req.params.memoryId as string;
    const { companyId, actor } = await resolveContext(req, agentId);
    const memory = await svc.forget(companyId, agentId, memoryId, actor);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent_memory_forgotten",
      entityType: "agent_memory",
      entityId: memory.id,
      agentId,
      details: { title: memory.title },
    });
    res.json(memory);
  });

  // Correct a memory: write a replacement and supersede the old one.
  router.post(
    "/agents/:agentId/memories/:memoryId/correct",
    validate(correctAgentMemorySchema),
    async (req, res) => {
      const agentId = req.params.agentId as string;
      const memoryId = req.params.memoryId as string;
      const { companyId, actor } = await resolveContext(req, agentId);
      const memory = await svc.correct(companyId, agentId, memoryId, req.body, actor);
      await logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        action: "agent_memory_corrected",
        entityType: "agent_memory",
        entityId: memory.id,
        agentId,
        details: { supersedesMemoryId: memoryId, title: memory.title },
      });
      res.status(201).json(memory);
    },
  );

  // Run one consolidation ("dreaming") pass now. Board-only; useful for QA and a
  // "Run consolidation" button. The scheduler runs this automatically on cadence.
  router.post("/agents/:agentId/memories/consolidate", async (req, res) => {
    const agentId = req.params.agentId as string;
    const agent = await agents.getById(agentId);
    if (!agent) throw notFound("Agent not found");
    assertCompanyAccess(req, agent.companyId);
    assertBoard(req);
    const result = await consolidation.consolidateAgentMemories(agent.companyId, agentId);
    res.json(result);
  });

  return router;
}
