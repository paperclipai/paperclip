import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  capabilityApplyEvents,
  capabilityApplyPlans,
  capabilityApplySteps,
} from "@paperclipai/db";
import {
  CAPABILITY_APPLY_ERROR_CODES,
  CAPABILITY_APPLY_RISK_CLASSES,
  buildCapabilityApplyPlan,
  type CapabilityApplyApprovalPayload,
  type CapabilityApplyPlanBuilderResult,
  type CapabilityApplyPlanInput,
  type CapabilityApplyPlanSummary,
  type CapabilityApplyRiskClass,
  type CapabilityApplyScopeSummary,
  type CapabilityApplySecretSummary,
  type CapabilityApplyStep,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import { logger } from "../middleware/logger.js";

// ── Stub executor ─────────────────────────────────────────────────────────────
// When capability.apply.live is OFF (always in this slice), the stub adapter
// records "would-execute" events without performing any real external action.
// The real executor adapter is never instantiated when the flag is OFF —
// enforced here and asserted in tests.

interface ExecutorAdapter {
  executeStep(step: CapabilityApplyStep, planId: string): Promise<{ wouldExecute: boolean }>;
}

class StubExecutorAdapter implements ExecutorAdapter {
  async executeStep(step: CapabilityApplyStep, planId: string): Promise<{ wouldExecute: boolean }> {
    logger.info(
      { planId, stepId: step.stepId, kind: step.kind, riskClass: step.riskClass },
      "[stub-executor] would-execute event recorded (live flag OFF)",
    );
    return { wouldExecute: true };
  }
}

function getExecutorAdapter(capabilityApplyLive: boolean): ExecutorAdapter {
  if (capabilityApplyLive) {
    // The real executor is not implemented in this slice (G.2 adds it).
    // Throw to prevent accidental live execution.
    throw new Error("capability.apply.live is ON but no real executor exists in G.1; upgrade to G.2 first");
  }
  return new StubExecutorAdapter();
}

// ── Secret-shape rejection ─────────────────────────────────────────────────────

const SECRET_SHAPE_RE =
  /(?:\b[A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\b\s*[:=]\s*[^\s]+|\bBearer\s+[^\s]+|\b(?:sk_(?:live|test)_|sk-|gh[opsu]_|github_pat_)[A-Za-z0-9_-]{12,}|\bAKIA[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/i;

function assertNoSecretShape(value: string, fieldPath: string): void {
  if (SECRET_SHAPE_RE.test(value)) {
    throw unprocessable(CAPABILITY_APPLY_ERROR_CODES.SECRET_SHAPED_IDENTIFIER, {
      code: CAPABILITY_APPLY_ERROR_CODES.SECRET_SHAPED_IDENTIFIER,
      field: fieldPath,
    });
  }
}

function validateStepTargetRefs(steps: CapabilityApplyStep[]): void {
  for (const step of steps) {
    if (step.target.catalogId) assertNoSecretShape(step.target.catalogId, `steps[${step.ordinal}].target.catalogId`);
    assertNoSecretShape(step.target.label, `steps[${step.ordinal}].target.label`);
    for (const ref of step.target.namedSecretRefs) {
      assertNoSecretShape(ref, `steps[${step.ordinal}].target.namedSecretRefs[]`);
    }
  }
}

// ── Event recording ──────────────────────────────────────────────────────────

interface EventContext {
  companyId: string;
  planId: string;
  stepId?: string;
  actorUserId?: string;
  actorAgentId?: string;
  runId?: string;
  dryRunHash?: string;
  agentId?: string;
}

async function recordEvent(
  db: Db,
  ctx: EventContext,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const redacted = redactEventPayload(payload) ?? {};
  logger.info(
    {
      companyId: ctx.companyId,
      agentId: ctx.agentId,
      planId: ctx.planId,
      stepId: ctx.stepId,
      dryRunHash: ctx.dryRunHash,
      runId: ctx.runId,
      actorUserId: ctx.actorUserId,
      actorAgentId: ctx.actorAgentId,
      kind,
      redactedPayload: redacted,
    },
    `capability_apply_event: ${kind}`,
  );
  await db.insert(capabilityApplyEvents).values({
    planId: ctx.planId,
    stepId: ctx.stepId ?? null,
    companyId: ctx.companyId,
    actorUserId: ctx.actorUserId ?? null,
    actorAgentId: ctx.actorAgentId ?? null,
    runId: ctx.runId ?? null,
    kind,
    payloadJson: redacted,
  });
}

// ── Plan row → summary ────────────────────────────────────────────────────────

function planRowToSummary(row: typeof capabilityApplyPlans.$inferSelect): CapabilityApplyPlanSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    dryRunHash: row.dryRunHash,
    state: row.state as CapabilityApplyPlanSummary["state"],
    steps: (row.stepsJson as CapabilityApplyStep[]) ?? [],
    approvalId: row.approvalId ?? null,
    optimisticVersion: row.optimisticVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Service factory ──────────────────────────────────────────────────────────

export function capabilityApplyService(db: Db, opts: { capabilityApplyLive: boolean }) {
  function stubExecutor() {
    // Expose for test spy assertions — the real adapter is never instantiated in G.1
    return getExecutorAdapter(opts.capabilityApplyLive);
  }

  return {
    /** Expose stub getter so tests can spy on adapter construction. */
    _getExecutorAdapter: () => getExecutorAdapter(opts.capabilityApplyLive),

    /**
     * POST /plans — build a plan from the effective delta. Idempotent on
     * (companyId, agentId, dryRunHash). Refuses governance_critical steps.
     */
    async createPlan(
      input: CapabilityApplyPlanInput,
      actor: { userId?: string; agentId?: string; runId?: string },
    ): Promise<CapabilityApplyPlanSummary> {
      const built: CapabilityApplyPlanBuilderResult = buildCapabilityApplyPlan(input);

      if (built.hasGovernanceCritical) {
        throw conflict(CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE, {
          code: CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE,
          governanceCriticalStepKinds: built.governanceCriticalStepKinds,
        });
      }

      // Allowlist enforcement: add_mcp_server steps require a catalogId (verified catalog entry).
      // Custom/uncataloged entries must go through a separate governance workflow.
      const unverifiedAddSteps = built.steps.filter(
        (s) => s.kind === "add_mcp_server" && !s.target.catalogId,
      );
      if (unverifiedAddSteps.length > 0) {
        throw conflict(CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE, {
          code: CAPABILITY_APPLY_ERROR_CODES.STEP_REQUIRES_GOVERNANCE,
          reason: "unverified_catalog_entry",
          stepOrdinals: unverifiedAddSteps.map((s) => s.ordinal),
        });
      }

      validateStepTargetRefs(built.steps);

      const idempotencyKey = `plan:apply:${input.companyId}:${input.agentId}:${built.dryRunHash}`;

      // Idempotent: if a plan with this hash already exists, return it
      const [existing] = await db
        .select()
        .from(capabilityApplyPlans)
        .where(
          and(
            eq(capabilityApplyPlans.companyId, input.companyId),
            eq(capabilityApplyPlans.agentId, input.agentId),
            eq(capabilityApplyPlans.dryRunHash, built.dryRunHash),
          ),
        )
        .limit(1);

      if (existing) {
        return planRowToSummary(existing);
      }

      // Redaction summary — what we redacted vs preserved; never contains values.
      const redactionSummary = {
        namedSecretRefCount: built.steps.reduce(
          (acc, s) => acc + s.target.namedSecretRefs.length,
          0,
        ),
        targetLabelsRedacted: false,
        catalogIdsRedacted: false,
        valuesPersisted: false,
      };

      const [plan] = await db
        .insert(capabilityApplyPlans)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          baseDesiredConfigRevisionId: input.proposalIdentity ?? null,
          dryRunHash: built.dryRunHash,
          state: "pending",
          stepsJson: built.steps as unknown[],
          redactionSummaryJson: redactionSummary as Record<string, unknown>,
          idempotencyKey,
          createdByUserId: actor.userId ?? null,
          createdByAgentId: actor.agentId ?? null,
        })
        .returning();

      if (!plan) throw new Error("Failed to insert plan");

      // Insert step rows
      if (built.steps.length > 0) {
        await db.insert(capabilityApplySteps).values(
          built.steps.map((s) => ({
            planId: plan.id,
            ordinal: s.ordinal,
            kind: s.kind,
            targetRefJson: { ...s.target } as Record<string, unknown>,
            riskClass: s.riskClass,
            annotationsJson: s.annotations as Record<string, unknown>,
            expectedNamedSecretsJson: s.target.namedSecretRefs,
            state: "pending" as const,
          })),
        );
      }

      await recordEvent(
        db,
        { companyId: input.companyId, agentId: input.agentId, planId: plan.id, dryRunHash: built.dryRunHash, actorUserId: actor.userId, actorAgentId: actor.agentId, runId: actor.runId },
        "capability_apply_plan_created",
        { dryRunHash: built.dryRunHash, stepCount: built.steps.length },
      );

      return planRowToSummary(plan);
    },

    /** GET /plans/:planId — read plan (redacted). */
    async getPlan(planId: string, companyId: string): Promise<CapabilityApplyPlanSummary> {
      const [row] = await db
        .select()
        .from(capabilityApplyPlans)
        .where(and(eq(capabilityApplyPlans.id, planId), eq(capabilityApplyPlans.companyId, companyId)))
        .limit(1);

      if (!row) throw notFound("Apply plan not found");
      return planRowToSummary(row);
    },

    /**
     * POST /plans/:planId/request-approval — server-builds the approval
     * payload from the locked plan. Does NOT trust client-supplied payload.
     */
    async requestApproval(
      planId: string,
      companyId: string,
      agentId: string,
      actor: { userId?: string; agentId?: string; runId?: string },
      ifMatchVersion: number,
    ): Promise<{ plan: CapabilityApplyPlanSummary; approvalPayload: CapabilityApplyApprovalPayload }> {
      const [row] = await db
        .select()
        .from(capabilityApplyPlans)
        .where(and(eq(capabilityApplyPlans.id, planId), eq(capabilityApplyPlans.companyId, companyId)))
        .limit(1);

      if (!row) throw notFound("Apply plan not found");
      if (row.agentId !== agentId) throw forbidden("Plan does not belong to this agent");
      if (row.optimisticVersion !== ifMatchVersion) {
        throw conflict(CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT, {
          code: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
          currentVersion: row.optimisticVersion,
        });
      }
      if (row.state !== "pending") {
        throw conflict(CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED, {
          code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED,
          currentState: row.state,
        });
      }

      const steps = (row.stepsJson as CapabilityApplyStep[]) ?? [];

      // Structured scopeSummary per LET-353 §2.2
      const stepsByRiskClass = CAPABILITY_APPLY_RISK_CLASSES.reduce(
        (acc, rc) => {
          acc[rc] = 0;
          return acc;
        },
        {} as Record<CapabilityApplyRiskClass, number>,
      );
      for (const s of steps) stepsByRiskClass[s.riskClass]++;

      // Look up agent label for the scope summary (label only — never a UUID inline)
      const [agentRow] = await db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, row.agentId))
        .limit(1);

      const totalNamedSecretRefs = steps.reduce(
        (acc, s) => acc + s.target.namedSecretRefs.length,
        0,
      );

      const scopeSummary: CapabilityApplyScopeSummary = {
        agentId: row.agentId,
        agentLabel: agentRow?.name ?? "agent",
        totalSteps: steps.length,
        stepsByRiskClass,
        totalNamedSecretRefs,
        hasGovernanceCritical: false,
      };

      const approvalPayload: CapabilityApplyApprovalPayload = {
        version: 1,
        planRevisionId: row.id,
        dryRunHash: row.dryRunHash,
        agentId: row.agentId,
        scopeSummary,
        steps: steps.map((s) => {
          const secretSummary: CapabilityApplySecretSummary = {
            namedSecretRefs: s.target.namedSecretRefs,
            count: s.target.namedSecretRefs.length,
            containsValues: false,
          };
          return {
            stepId: s.stepId,
            kind: s.kind,
            target: { catalogId: s.target.catalogId, label: s.target.label },
            riskClass: s.riskClass,
            annotations: s.annotations as Record<string, boolean>,
            sideEffects: s.sideEffects,
            secretSummary,
          };
        }),
        liveExecutionFlagState: "off",
        noLiveActionAttestation: true,
      };

      // Idempotent durable approval row binding per LET-353 §3.2
      // Key: approval:apply:{planId}:{dryRunHash}
      // If an approval already exists for this plan, reuse it; otherwise create one.
      let approvalId: string = row.approvalId ?? "";
      if (!approvalId) {
        const [createdApproval] = await db
          .insert(approvals)
          .values({
            companyId,
            type: "capability_apply",
            status: "pending",
            payload: approvalPayload as unknown as Record<string, unknown>,
            requestedByAgentId: actor.agentId ?? null,
            requestedByUserId: actor.userId ?? null,
          })
          .returning({ id: approvals.id });
        if (!createdApproval) throw new Error("Failed to create approval row");
        approvalId = createdApproval.id;
      }

      // Transition to approval_requested AND bind approvalId atomically
      const [updated] = await db
        .update(capabilityApplyPlans)
        .set({
          state: "approval_requested",
          approvalId,
          optimisticVersion: row.optimisticVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(capabilityApplyPlans.id, planId),
            eq(capabilityApplyPlans.optimisticVersion, ifMatchVersion),
          ),
        )
        .returning();

      if (!updated) {
        throw conflict(CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT, {
          code: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
        });
      }

      await recordEvent(
        db,
        { companyId, agentId: row.agentId, planId: row.id, dryRunHash: row.dryRunHash, actorUserId: actor.userId, actorAgentId: actor.agentId, runId: actor.runId },
        "capability_apply_approval_requested",
        { liveExecutionFlagState: "off", approvalId },
      );

      return { plan: planRowToSummary(updated), approvalPayload };
    },

    /**
     * POST /plans/:planId/cancel — owner/creator only.
     */
    async cancelPlan(
      planId: string,
      companyId: string,
      actor: { userId?: string; agentId?: string; runId?: string },
      ifMatchVersion: number,
    ): Promise<CapabilityApplyPlanSummary> {
      const [row] = await db
        .select()
        .from(capabilityApplyPlans)
        .where(and(eq(capabilityApplyPlans.id, planId), eq(capabilityApplyPlans.companyId, companyId)))
        .limit(1);

      if (!row) throw notFound("Apply plan not found");

      // Creator check
      const creatorUserId = row.createdByUserId;
      const creatorAgentId = row.createdByAgentId;
      const isCreator =
        (actor.userId && actor.userId === creatorUserId) ||
        (actor.agentId && actor.agentId === creatorAgentId);
      if (!isCreator) throw forbidden("Only the plan creator can cancel this plan");

      if (row.optimisticVersion !== ifMatchVersion) {
        throw conflict(CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT, {
          code: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
          currentVersion: row.optimisticVersion,
        });
      }

      const terminal = ["applied", "cancelled", "declined", "expired"];
      if (terminal.includes(row.state)) {
        throw conflict(CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED, {
          code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED,
          currentState: row.state,
        });
      }

      const [updated] = await db
        .update(capabilityApplyPlans)
        .set({
          state: "cancelled",
          optimisticVersion: row.optimisticVersion + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(capabilityApplyPlans.id, planId),
            eq(capabilityApplyPlans.optimisticVersion, ifMatchVersion),
          ),
        )
        .returning();

      if (!updated) {
        throw conflict(CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT, {
          code: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
        });
      }

      await recordEvent(
        db,
        { companyId, planId: row.id, dryRunHash: row.dryRunHash, actorUserId: actor.userId, actorAgentId: actor.agentId, runId: actor.runId },
        "capability_apply_plan_cancelled",
        {},
      );

      return planRowToSummary(updated);
    },

    /** GET /plans/:planId/events */
    async getPlanEvents(planId: string, companyId: string) {
      const [plan] = await db
        .select({ id: capabilityApplyPlans.id })
        .from(capabilityApplyPlans)
        .where(and(eq(capabilityApplyPlans.id, planId), eq(capabilityApplyPlans.companyId, companyId)))
        .limit(1);

      if (!plan) throw notFound("Apply plan not found");

      const events = await db
        .select()
        .from(capabilityApplyEvents)
        .where(eq(capabilityApplyEvents.planId, planId))
        .orderBy(capabilityApplyEvents.createdAt);

      return events.map((e) => ({
        id: e.id,
        planId: e.planId,
        stepId: e.stepId ?? null,
        companyId: e.companyId,
        actorUserId: e.actorUserId ?? null,
        actorAgentId: e.actorAgentId ?? null,
        runId: e.runId ?? null,
        kind: e.kind,
        payload: (e.payloadJson as Record<string, unknown>) ?? {},
        createdAt: e.createdAt.toISOString(),
      }));
    },

    stubExecutor,
  };
}
