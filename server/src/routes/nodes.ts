import { Router, type Request } from "express";
import { and, eq, inArray, isNull, asc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";
import { createNodeSchema, updateNodeSchema, createNodeKeySchema } from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { nodeService, publishLiveEvent } from "../services/index.js";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";
import { remoteRunWaiters, remoteCompletionEmitter } from "@paperclipai/adapter-remote-node/server";
import { parseObject, asString } from "@paperclipai/adapter-utils/server-utils";

function param(req: Request, key: string): string {
  const v = req.params[key];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : "";
}

export function nodeRoutes(db: Db) {
  const router = Router();
  const nodeSvc = nodeService(db);

  // =========================================================================
  // Board-facing CRUD: /companies/:companyId/nodes
  // =========================================================================

  // POST /companies/:companyId/nodes — register a new node
  router.post(
    "/companies/:companyId/nodes",
    validate(createNodeSchema),
    async (req, res, next) => {
      try {
        assertBoard(req);
        const companyId = param(req, "companyId");
        assertCompanyAccess(req, companyId);
        const actor = getActorInfo(req);

        const node = await nodeSvc.create({
          companyId,
          name: req.body.name,
          capabilities: req.body.capabilities,
          metadata: req.body.metadata,
          actorType: actor.actorType,
          actorId: actor.actorId,
        });

        // Auto-create an API key for the node
        const apiKey = await nodeSvc.createApiKey({
          nodeId: node.id,
          companyId,
          name: "default",
        });

        res.status(201).json({ node, apiKey: { id: apiKey.id, key: apiKey.key } });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /companies/:companyId/nodes — list nodes
  router.get("/companies/:companyId/nodes", async (req, res, next) => {
    try {
      const companyId = param(req, "companyId");
      assertCompanyAccess(req, companyId);

      const rows = await nodeSvc.list(companyId);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  // GET /companies/:companyId/nodes/:nodeId — get node details
  router.get("/companies/:companyId/nodes/:nodeId", async (req, res, next) => {
    try {
      const companyId = param(req, "companyId");
      const nodeId = param(req, "nodeId");
      assertCompanyAccess(req, companyId);

      const node = await nodeSvc.getById(nodeId);
      if (!node || node.companyId !== companyId) throw notFound("Node not found");

      res.json(node);
    } catch (err) {
      next(err);
    }
  });

  // PATCH /companies/:companyId/nodes/:nodeId — update node
  router.patch(
    "/companies/:companyId/nodes/:nodeId",
    validate(updateNodeSchema),
    async (req, res, next) => {
      try {
        assertBoard(req);
        const companyId = param(req, "companyId");
        const nodeId = param(req, "nodeId");
        assertCompanyAccess(req, companyId);

        const existing = await nodeSvc.getById(nodeId);
        if (!existing || existing.companyId !== companyId) throw notFound("Node not found");

        const updated = await nodeSvc.update(nodeId, req.body);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /companies/:companyId/nodes/:nodeId — deregister node
  router.delete("/companies/:companyId/nodes/:nodeId", async (req, res, next) => {
    try {
      assertBoard(req);
      const companyId = param(req, "companyId");
      const nodeId = param(req, "nodeId");
      assertCompanyAccess(req, companyId);

      const existing = await nodeSvc.getById(nodeId);
      if (!existing || existing.companyId !== companyId) throw notFound("Node not found");

      await nodeSvc.remove(nodeId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /companies/:companyId/nodes/:nodeId/keys — create new API key for node
  router.post(
    "/companies/:companyId/nodes/:nodeId/keys",
    validate(createNodeKeySchema),
    async (req, res, next) => {
      try {
        assertBoard(req);
        const companyId = param(req, "companyId");
        const nodeId = param(req, "nodeId");
        assertCompanyAccess(req, companyId);

        const existing = await nodeSvc.getById(nodeId);
        if (!existing || existing.companyId !== companyId) throw notFound("Node not found");

        const apiKey = await nodeSvc.createApiKey({
          nodeId,
          companyId,
          name: req.body.name,
        });

        res.status(201).json({ id: apiKey.id, key: apiKey.key });
      } catch (err) {
        next(err);
      }
    },
  );

  // =========================================================================
  // Runner-facing endpoints: /nodes/:nodeId/*
  // These are authenticated by node API key (Bearer token).
  // =========================================================================

  async function authenticateNodeRunner(req: Request) {
    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      throw unauthorized("Node API key required");
    }
    const token = authHeader.slice("bearer ".length).trim();
    if (!token) throw unauthorized("Node API key required");

    const key = await nodeSvc.validateApiKey(token);
    if (!key) throw unauthorized("Invalid or revoked node API key");

    const nodeId = param(req, "nodeId");
    if (key.nodeId !== nodeId) throw forbidden("API key does not belong to this node");

    return { nodeId: key.nodeId, companyId: key.companyId, keyId: key.id };
  }

  // POST /nodes/:nodeId/heartbeat — runner keepalive
  router.post("/nodes/:nodeId/heartbeat", async (req, res, next) => {
    try {
      const auth = await authenticateNodeRunner(req);

      const node = await nodeSvc.recordHeartbeat(auth.nodeId);
      if (!node) throw notFound("Node not found");

      // Count pending runs for agents on this node
      const pendingCount = await countPendingRunsForNode(db, auth.nodeId, auth.companyId);

      publishLiveEvent({
        companyId: auth.companyId,
        type: "node.status",
        payload: { nodeId: auth.nodeId, status: "online" },
      });

      res.json({ ok: true, pendingRuns: pendingCount });
    } catch (err) {
      next(err);
    }
  });

  // POST /nodes/:nodeId/claim — runner claims next queued run
  router.post("/nodes/:nodeId/claim", async (req, res, next) => {
    try {
      const auth = await authenticateNodeRunner(req);

      // Find agents configured for this node
      const nodeAgents = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.companyId, auth.companyId),
            eq(agents.adapterType, "remote_node"),
          ),
        );

      // Filter to agents whose adapterConfig.nodeId matches
      const matchingAgentIds = nodeAgents
        .filter((a) => {
          const config = parseObject(a.adapterConfig);
          return asString(config.nodeId, "") === auth.nodeId;
        })
        .map((a) => a.id);

      if (matchingAgentIds.length === 0) {
        res.status(204).end();
        return;
      }

      // Find the oldest run that is running but not yet remotely claimed
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            inArray(heartbeatRuns.agentId, matchingAgentIds),
            eq(heartbeatRuns.status, "running"),
            isNull(heartbeatRuns.remoteClaimedAt),
          ),
        )
        .orderBy(asc(heartbeatRuns.createdAt))
        .limit(1);

      if (!run) {
        res.status(204).end();
        return;
      }

      // Atomically mark as remotely claimed
      const now = new Date();
      const [claimed] = await db
        .update(heartbeatRuns)
        .set({ remoteClaimedAt: now, updatedAt: now })
        .where(
          and(
            eq(heartbeatRuns.id, run.id),
            eq(heartbeatRuns.status, "running"),
            isNull(heartbeatRuns.remoteClaimedAt),
          ),
        )
        .returning();

      if (!claimed) {
        res.status(204).end();
        return;
      }

      const agent = nodeAgents.find((a) => a.id === claimed.agentId);
      if (!agent) {
        res.status(204).end();
        return;
      }

      const config = parseObject(agent.adapterConfig);

      res.json({
        runId: claimed.id,
        agentId: claimed.agentId,
        companyId: claimed.companyId,
        contextSnapshot: claimed.contextSnapshot ?? {},
        adapterConfig: config,
        sessionIdBefore: claimed.sessionIdBefore,
        runtime: {
          sessionId: claimed.sessionIdBefore,
          taskKey: null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // POST /nodes/:nodeId/runs/:runId/log — stream log chunks
  router.post("/nodes/:nodeId/runs/:runId/log", async (req, res, next) => {
    try {
      await authenticateNodeRunner(req);
      const runId = param(req, "runId");

      const stream = typeof req.body.stream === "string" ? req.body.stream : "stdout";
      const chunk = typeof req.body.chunk === "string" ? req.body.chunk : "";

      if (!chunk) {
        res.json({ ok: true });
        return;
      }

      // Check if run was cancelled
      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));

      if (run?.status === "cancelled") {
        res.status(409).json({ error: "Run cancelled" });
        return;
      }

      // Forward to the waiting execute()'s onLog callback
      const waiter = remoteRunWaiters.get(runId);
      if (waiter) {
        await waiter.onLog(stream as "stdout" | "stderr", chunk);
      }

      // Update run's updatedAt to prevent reaping
      await db
        .update(heartbeatRuns)
        .set({ updatedAt: new Date() })
        .where(eq(heartbeatRuns.id, runId));

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /nodes/:nodeId/runs/:runId/report — report run completion
  router.post("/nodes/:nodeId/runs/:runId/report", async (req, res, next) => {
    try {
      await authenticateNodeRunner(req);
      const runId = param(req, "runId");

      const body = req.body as Record<string, unknown>;

      const result = {
        exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
        signal: typeof body.signal === "string" ? body.signal : null,
        timedOut: body.timedOut === true,
        errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : undefined,
        errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined,
        usage: body.usage as { inputTokens: number; outputTokens: number; cachedInputTokens?: number } | undefined,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        sessionParams: (typeof body.sessionParams === "object" && body.sessionParams !== null)
          ? body.sessionParams as Record<string, unknown>
          : undefined,
        sessionDisplayId: typeof body.sessionDisplayId === "string" ? body.sessionDisplayId : undefined,
        provider: typeof body.provider === "string" ? body.provider : undefined,
        model: typeof body.model === "string" ? body.model : undefined,
        billingType: typeof body.billingType === "string" ? body.billingType as "api" | "subscription" | "unknown" : undefined,
        costUsd: typeof body.costUsd === "number" ? body.costUsd : undefined,
        resultJson: (typeof body.resultJson === "object" && body.resultJson !== null)
          ? body.resultJson as Record<string, unknown>
          : undefined,
        summary: typeof body.summary === "string" ? body.summary : undefined,
        clearSession: body.clearSession === true,
      };

      // Resolve the waiting execute() promise
      const waiter = remoteRunWaiters.get(runId);
      if (waiter) {
        remoteRunWaiters.delete(runId);
        waiter.resolve(result);
      }

      // Also emit on the completion emitter as backup
      remoteCompletionEmitter.emit("run.complete", { runId, result });

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function countPendingRunsForNode(db: Db, nodeId: string, companyId: string) {
  const nodeAgents = await db
    .select({ id: agents.id, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(
      and(eq(agents.companyId, companyId), eq(agents.adapterType, "remote_node")),
    );

  const matchingIds = nodeAgents
    .filter((a) => {
      const config = parseObject(a.adapterConfig);
      return asString(config.nodeId, "") === nodeId;
    })
    .map((a) => a.id);

  if (matchingIds.length === 0) return 0;

  const runs = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        inArray(heartbeatRuns.agentId, matchingIds),
        eq(heartbeatRuns.status, "running"),
        isNull(heartbeatRuns.remoteClaimedAt),
      ),
    );

  return runs.length;
}
