import { Router } from "express";
import type { Request } from "express";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { executeMergedAgentToolSchema } from "@paperclipai/shared";
import { forbidden, notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertBoardOrAgent, assertCompanyAccess } from "./authz.js";
import { agentToolCatalogService, type AgentToolCatalogDeps } from "../services/agent-tools.js";
import { secretService } from "../services/index.js";

// Merged plugin + MCP tool surface, per agent (NEO-286 D2-4, plan §5).
// Agents call the index once at init, fetch schemas on demand, and execute
// server-side — nothing here injects tools into adapter prompts.

async function assertToolSurfaceAccess(
  req: Request,
  db: Db,
  companyId: string,
  agentId: string,
): Promise<void> {
  assertBoardOrAgent(req);
  assertCompanyAccess(req, companyId);
  if (req.actor.type === "agent") {
    // An agent may only read (or execute against) its own tool surface.
    if (req.actor.agentId !== agentId) {
      throw forbidden("Agent key cannot access another agent's tools");
    }
    return;
  }
  const [agent] = await db
    .select({ companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent || agent.companyId !== companyId) {
    throw notFound("Agent not found");
  }
}

export function agentToolRoutes(
  db: Db,
  deps: Pick<AgentToolCatalogDeps, "toolDispatcher">,
) {
  const router = Router();
  const catalog = agentToolCatalogService(db, {
    secrets: secretService(db),
    toolDispatcher: deps.toolDispatcher ?? null,
  });

  router.get("/companies/:companyId/agents/:agentId/tools", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertToolSurfaceAccess(req, db, companyId, agentId);
    res.json(await catalog.listMergedIndex(companyId, agentId));
  });

  router.get("/companies/:companyId/agents/:agentId/tools/schema", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    await assertToolSurfaceAccess(req, db, companyId, agentId);
    const name = typeof req.query.name === "string" ? req.query.name.trim() : "";
    if (!name) {
      res.status(400).json({ error: '"name" query parameter is required' });
      return;
    }
    res.json(await catalog.getToolSchema(companyId, agentId, name));
  });

  router.post(
    "/companies/:companyId/agents/:agentId/tools/execute",
    validate(executeMergedAgentToolSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      // Execution is run-scoped and agent-only: the executing identity must
      // be the agent whose tool surface this is, on a live heartbeat run.
      if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId) {
        res.status(401).json({ error: "Run-scoped agent authentication required" });
        return;
      }
      await assertToolSurfaceAccess(req, db, companyId, agentId);

      const [run] = await db
        .select({ companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, req.actor.runId))
        .limit(1);
      if (!run || run.companyId !== companyId || run.agentId !== agentId) {
        res.status(404).json({ error: "Heartbeat run not found for this agent" });
        return;
      }

      const result = await catalog.execute(
        {
          companyId,
          agentId,
          runId: req.actor.runId,
        },
        req.body,
      );
      res.json(result);
    },
  );

  return router;
}
