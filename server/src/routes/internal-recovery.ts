import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { heartbeatRuns, issues } from "@paperclipai/db";
import { ISSUE_RECOVERY_ACTION_OUTCOMES } from "@paperclipai/shared";
import { z } from "zod";
import { validate } from "../middleware/validate.js";
import { badRequest } from "../errors.js";
import { internalSecretAuth } from "./internal-auth.js";
import { recoveryService } from "../services/recovery/service.js";
import { issueRecoveryActionService } from "../services/issue-recovery-actions.js";
import {
  recoveryWorkflowAdapter,
  type IssueRow,
  type LatestRunRow,
  type RecoveryWorkflowAdapterDeps,
} from "../services/recovery-workflow-adapter.js";

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

const attemptBodySchema = z.object({
  companyId: z.string(),
  sourceIssueId: z.string(),
  attemptNumber: z.number().int().positive(),
  mode: z.enum(["dry", "active"]),
});

const resolveEscalateBodySchema = z.object({
  companyId: z.string(),
  sourceIssueId: z.string(),
  outcome: z.enum(ISSUE_RECOVERY_ACTION_OUTCOMES).optional(),
  note: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

/**
 * enqueueWakeup is heartbeat.wakeup, used to construct recoveryService
 * (mirrors agents.ts). Typed structurally as the parameter recoveryService
 * expects so we don't depend on a non-exported internal type.
 */
type EnqueueWakeup = Parameters<typeof recoveryService>[1]["enqueueWakeup"];

export type InternalRecoveryRoutesDeps = {
  /** heartbeat.wakeup — used to construct recoveryService (mirrors agents.ts) */
  enqueueWakeup: EnqueueWakeup;
  /** config.heartbeatSchedulerIntervalMs — nextIntervalMs for attempts */
  heartbeatIntervalMs: number;
};

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function internalRecoveryRoutes(db: Db, deps: InternalRecoveryRoutesDeps) {
  const router = Router();

  // All routes under /internal require the shared secret
  router.use("/internal", internalSecretAuth);

  // Wire the REAL adapter using the production recipe from
  // recovery-workflow-adapter.ts's JSDoc. Tests mock the adapter module
  // entirely (vi.mock), so this wiring does not affect the route tests.
  const recoverySvc = recoveryService(db, { enqueueWakeup: deps.enqueueWakeup });
  const recoveryActionsSvc = issueRecoveryActionService(db);
  const adapter = recoveryWorkflowAdapter({
    // The real service requires the full issues.$inferSelect row; the adapter's
    // dep contract uses the looser IssueRow index type. fetchIssue returns the
    // full row at runtime, so the shapes are runtime-compatible. Use
    // as unknown as to bridge the contravariant parameter mismatch at this
    // wiring boundary (the cast is safe: the actual value passed at runtime
    // is always a full DB row from fetchIssue above).
    escalateStrandedAssignedIssue:
      recoverySvc.escalateStrandedAssignedIssue as unknown as RecoveryWorkflowAdapterDeps["escalateStrandedAssignedIssue"],
    getActiveForIssue: recoveryActionsSvc.getActiveForIssue,
    resolveActiveForIssue: recoveryActionsSvc.resolveActiveForIssue,
    fetchIssue: (companyId, issueId) =>
      db
        .select()
        .from(issues)
        .where(and(eq(issues.companyId, companyId), eq(issues.id, issueId)))
        .limit(1)
        .then((rows) => (rows[0] ?? null) as IssueRow | null),
    fetchLatestRun: (companyId, issueId) =>
      db
        .select({
          id: heartbeatRuns.id,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          error: heartbeatRuns.error,
          errorCode: heartbeatRuns.errorCode,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          livenessState: heartbeatRuns.livenessState,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, companyId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ),
        )
        .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
        .limit(1)
        .then((rows) => (rows[0] ?? null) as LatestRunRow),
    heartbeatIntervalMs: deps.heartbeatIntervalMs,
  });

  // ---- GET /internal/recovery/:actionId ------------------------------------
  // Returns the current state of the recovery action.
  // Query params: companyId, sourceIssueId (both required)

  router.get("/internal/recovery/:actionId", async (req, res) => {
    const { companyId, sourceIssueId } = req.query as {
      companyId?: string;
      sourceIssueId?: string;
    };

    if (!companyId || !sourceIssueId) {
      throw badRequest("companyId and sourceIssueId query params are required");
    }

    const state = await adapter.getState(companyId, sourceIssueId);
    if (!state) {
      res.json({ active: false, status: "not_found", attemptCount: 0 });
      return;
    }
    res.json(state);
  });

  // ---- POST /internal/recovery/:actionId/attempt ---------------------------
  // Performs (or previews in dry mode) a single recovery attempt.

  router.post(
    "/internal/recovery/:actionId/attempt",
    validate(attemptBodySchema),
    async (req, res) => {
      const actionId = req.params.actionId as string;
      const { companyId, sourceIssueId, attemptNumber, mode } = req.body as z.infer<
        typeof attemptBodySchema
      >;

      const result = await adapter.performAttempt({
        companyId,
        sourceIssueId,
        actionId,
        attemptNumber,
        mode,
      });
      res.json(result);
    },
  );

  // ---- POST /internal/recovery/:actionId/resolve ---------------------------
  // Marks the recovery action as resolved.

  router.post(
    "/internal/recovery/:actionId/resolve",
    validate(resolveEscalateBodySchema),
    async (req, res) => {
      const actionId = req.params.actionId as string;
      const { companyId, sourceIssueId, outcome, note } = req.body as z.infer<
        typeof resolveEscalateBodySchema
      >;

      const result = await adapter.resolve({
        companyId,
        sourceIssueId,
        actionId,
        status: "resolved",
        outcome: outcome ?? "restored",
        resolutionNote: note ?? null,
      });
      res.json({ status: result?.status ?? "resolved" });
    },
  );

  // ---- POST /internal/recovery/:actionId/escalate --------------------------
  // Cancels/escalates the recovery action.

  router.post(
    "/internal/recovery/:actionId/escalate",
    validate(resolveEscalateBodySchema),
    async (req, res) => {
      const actionId = req.params.actionId as string;
      const { companyId, sourceIssueId } = req.body as z.infer<typeof resolveEscalateBodySchema>;

      const result = await adapter.escalate({
        companyId,
        sourceIssueId,
        actionId,
      });
      res.json({ status: result?.status ?? "cancelled" });
    },
  );

  return router;
}
