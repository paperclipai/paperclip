import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, agents as agentsTable } from "@paperclipai/db";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

const VALID_INTERRUPT_MODES = ["hint", "correction", "hard_override"] as const;
type InterruptMode = (typeof VALID_INTERRUPT_MODES)[number];

export function runRoutes(db: Db) {
  const router = Router();

  // ─── Helpers ──────────────────────────────────────────────────────────

  async function getRunOrThrow(runId: string, companyId: string) {
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, companyId)))
      .limit(1);
    if (!run) throw notFound("Run not found");
    return run;
  }

  async function getAgentOrThrow(agentId: string, companyId: string) {
    const [agent] = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, agentId), eq(agentsTable.companyId, companyId)))
      .limit(1);
    if (!agent) throw notFound("Agent not found");
    return agent;
  }

  // ─── POST /companies/:companyId/runs/:runId/pause ─────────────────────

  router.post("/companies/:companyId/runs/:runId/pause", async (req, res) => {
    assertBoard(req);
    const { companyId, runId } = req.params;
    assertCompanyAccess(req, companyId);

    const run = await getRunOrThrow(runId, companyId);

    if (run.status !== "running") {
      throw unprocessable(`Cannot pause a run with status "${run.status}"`);
    }
    if (run.pausedAt) {
      throw unprocessable("Run is already paused");
    }

    const now = new Date();
    const [updated] = await db
      .update(heartbeatRuns)
      .set({
        pausedAt: now,
        status: "paused",
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning();

    res.json(updated);
  });

  // ─── POST /companies/:companyId/runs/:runId/resume ────────────────────

  router.post("/companies/:companyId/runs/:runId/resume", async (req, res) => {
    assertBoard(req);
    const { companyId, runId } = req.params;
    assertCompanyAccess(req, companyId);

    const run = await getRunOrThrow(runId, companyId);

    if (run.status !== "paused") {
      throw unprocessable(`Cannot resume a run with status "${run.status}"`);
    }

    const now = new Date();
    const [updated] = await db
      .update(heartbeatRuns)
      .set({
        pausedAt: null,
        status: "running",
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning();

    res.json(updated);
  });

  // ─── POST /companies/:companyId/runs/:runId/interrupt ─────────────────

  router.post("/companies/:companyId/runs/:runId/interrupt", async (req, res) => {
    assertBoard(req);
    const { companyId, runId } = req.params;
    assertCompanyAccess(req, companyId);

    const { message, mode } = req.body ?? {};

    if (!message || typeof message !== "string") {
      throw badRequest("message is required and must be a string");
    }
    if (!mode || !VALID_INTERRUPT_MODES.includes(mode as InterruptMode)) {
      throw badRequest(`mode must be one of: ${VALID_INTERRUPT_MODES.join(", ")}`);
    }

    const run = await getRunOrThrow(runId, companyId);

    if (run.status !== "running" && run.status !== "paused") {
      throw unprocessable(`Cannot interrupt a run with status "${run.status}"`);
    }

    const now = new Date();
    const [updated] = await db
      .update(heartbeatRuns)
      .set({
        interruptedAt: now,
        interruptMessage: message,
        interruptMode: mode,
        status: "interrupted",
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning();

    res.json(updated);
  });

  // ─── POST /companies/:companyId/runs/:runId/abort ─────────────────────

  router.post("/companies/:companyId/runs/:runId/abort", async (req, res) => {
    assertBoard(req);
    const { companyId, runId } = req.params;
    assertCompanyAccess(req, companyId);

    const run = await getRunOrThrow(runId, companyId);

    const terminalStatuses = ["completed", "failed", "aborted"];
    if (terminalStatuses.includes(run.status)) {
      throw unprocessable(`Cannot abort a run with status "${run.status}"`);
    }

    const now = new Date();
    const [updated] = await db
      .update(heartbeatRuns)
      .set({
        status: "aborted",
        finishedAt: now,
        circuitBreakerTripped: true,
        circuitBreakerReason: (req.body as { reason?: string } | undefined)?.reason ?? "Manual abort by operator",
        updatedAt: now,
      })
      .where(eq(heartbeatRuns.id, runId))
      .returning();

    res.json(updated);
  });

  // ─── PATCH /companies/:companyId/agents/:agentId/maximizer ────────────

  router.patch("/companies/:companyId/agents/:agentId/maximizer", async (req, res) => {
    assertBoard(req);
    const { companyId, agentId } = req.params;
    assertCompanyAccess(req, companyId);

    const agent = await getAgentOrThrow(agentId, companyId);

    const {
      enabled,
      maxConsecutiveFailures,
      maxRunsWithoutProgress,
      tokenVelocityLimit,
      autoApprove,
    } = req.body ?? {};

    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (typeof enabled === "boolean") {
      updates.maximizerEnabled = enabled;
    }
    if (typeof maxConsecutiveFailures === "number") {
      if (maxConsecutiveFailures < 1 || maxConsecutiveFailures > 100) {
        throw badRequest("maxConsecutiveFailures must be between 1 and 100");
      }
      updates.maximizerMaxConsecutiveFailures = maxConsecutiveFailures;
    }
    if (typeof maxRunsWithoutProgress === "number") {
      if (maxRunsWithoutProgress < 1 || maxRunsWithoutProgress > 100) {
        throw badRequest("maxRunsWithoutProgress must be between 1 and 100");
      }
      updates.maximizerMaxRunsWithoutProgress = maxRunsWithoutProgress;
    }
    if (tokenVelocityLimit !== undefined) {
      if (tokenVelocityLimit !== null && (typeof tokenVelocityLimit !== "number" || tokenVelocityLimit < 0)) {
        throw badRequest("tokenVelocityLimit must be a positive number or null");
      }
      updates.maximizerTokenVelocityLimit = tokenVelocityLimit;
    }
    if (typeof autoApprove === "boolean") {
      updates.maximizerAutoApprove = autoApprove;
    }

    const [updated] = await db
      .update(agentsTable)
      .set(updates)
      .where(eq(agentsTable.id, agentId))
      .returning();

    res.json({
      id: updated.id,
      maximizerEnabled: updated.maximizerEnabled,
      maximizerMaxConsecutiveFailures: updated.maximizerMaxConsecutiveFailures,
      maximizerMaxRunsWithoutProgress: updated.maximizerMaxRunsWithoutProgress,
      maximizerTokenVelocityLimit: updated.maximizerTokenVelocityLimit,
      maximizerAutoApprove: updated.maximizerAutoApprove,
    });
  });

  return router;
}
