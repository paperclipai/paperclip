import { and, eq, sql } from "drizzle-orm";
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
  type CapabilityApplyPlanState,
  type CapabilityApplyPlanSummary,
  type CapabilityApplyRiskClass,
  type CapabilityApplyScopeSummary,
  type CapabilityApplySecretSummary,
  type CapabilityApplyStep,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { redactEventPayload } from "../redaction.js";
import { logger } from "../middleware/logger.js";

// A handle that may be either the root Db or an in-flight transaction. Drizzle's
// tx object is structurally compatible at the query-method surface; we type the
// helpers down to the methods actually used so plan + step + event writes can
// share a single transaction.
type DbHandle = Pick<Db, "select" | "insert" | "update">;

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
    // The real executor is not implemented in this slice (G.2 keeps the live
    // flag OFF and only ships the internal_safe state machine).
    // Throw to prevent accidental live execution if the flag is flipped before
    // a future slice (G.3+) wires real adapters in.
    throw new Error("capability.apply.live is ON but no real executor exists in G.2; upgrade to G.3 first");
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
  dbOrTx: DbHandle,
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
  await dbOrTx.insert(capabilityApplyEvents).values({
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

// Plan states a fresh /execute may transition out of. Anything else means the
// plan has already been consumed, cancelled, or has not reached approval yet.
const EXECUTE_ALLOWED_PRIOR_STATES: ReadonlyArray<CapabilityApplyPlanState> = [
  "approval_requested",
  "approved",
];

// Plan states that already represent a terminal or post-execute outcome.
const TERMINAL_OR_POST_EXECUTE_STATES: ReadonlyArray<CapabilityApplyPlanState> = [
  "executing",
  "applied",
  "partially_applied",
  "cancelled",
  "declined",
  "expired",
];

// ── Service factory ──────────────────────────────────────────────────────────

export function capabilityApplyService(db: Db, opts: { capabilityApplyLive: boolean }) {
  return {
    /** Expose stub getter so tests can spy on adapter construction. */
    _getExecutorAdapter: () => getExecutorAdapter(opts.capabilityApplyLive),

    /**
     * POST /plans — build a plan from the effective delta. Idempotent on
     * (companyId, agentId, dryRunHash). Refuses governance_critical steps.
     *
     * LET-395 hardening: plan + steps + initial event are inserted in a single
     * transaction so a partial insert cannot leave an executable plan with
     * missing steps or no created-event audit row.
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

      return db.transaction(async (tx) => {
        // Idempotent: if a plan with this (companyId, agentId, hash) tuple
        // already exists, return it. Index `cap_apply_plans_company_agent_hash_uidx`
        // makes this a single point-lookup and DB-enforces uniqueness if two
        // concurrent inserts race past this check.
        const [existing] = await tx
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

        const redactionSummary = {
          namedSecretRefCount: built.steps.reduce(
            (acc, s) => acc + s.target.namedSecretRefs.length,
            0,
          ),
          targetLabelsRedacted: false,
          catalogIdsRedacted: false,
          valuesPersisted: false,
        };

        const [plan] = await tx
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

        if (built.steps.length > 0) {
          await tx.insert(capabilityApplySteps).values(
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
          tx,
          {
            companyId: input.companyId,
            agentId: input.agentId,
            planId: plan.id,
            dryRunHash: built.dryRunHash,
            actorUserId: actor.userId,
            actorAgentId: actor.agentId,
            runId: actor.runId,
          },
          "capability_apply_plan_created",
          { dryRunHash: built.dryRunHash, stepCount: built.steps.length },
        );

        return planRowToSummary(plan);
      });
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

      const stepsByRiskClass = CAPABILITY_APPLY_RISK_CLASSES.reduce(
        (acc, rc) => {
          acc[rc] = 0;
          return acc;
        },
        {} as Record<CapabilityApplyRiskClass, number>,
      );
      for (const s of steps) stepsByRiskClass[s.riskClass]++;

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

      // LET-395: bind approval creation + plan state transition in one
      // transaction so a crash between the two cannot leave an orphaned
      // approval row or a plan stuck in `pending` with an approvalId set.
      return db.transaction(async (tx) => {
        let approvalId: string = row.approvalId ?? "";
        if (!approvalId) {
          const [createdApproval] = await tx
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

        const [updated] = await tx
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
          tx,
          {
            companyId,
            agentId: row.agentId,
            planId: row.id,
            dryRunHash: row.dryRunHash,
            actorUserId: actor.userId,
            actorAgentId: actor.agentId,
            runId: actor.runId,
          },
          "capability_apply_approval_requested",
          { liveExecutionFlagState: "off", approvalId },
        );

        return { plan: planRowToSummary(updated), approvalPayload };
      });
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

      const terminal = ["applied", "cancelled", "declined", "expired", "partially_applied"];
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

    /**
     * POST /plans/:planId/execute — LET-395 G.2 deterministic apply state machine.
     *
     * Contract:
     *   - Requires company + agent ownership (caller enforces companyAccess; we
     *     re-check the agent boundary against the plan row).
     *   - Requires hash-bound approved approval. The approval payload's
     *     dryRunHash and planRevisionId must match the locked plan.
     *   - Refuses stale/declined/cancelled/expired approvals with stable error
     *     codes (APPROVAL_NOT_ACCEPTED / APPROVAL_CONSUMED / PLAN_HASH_MISMATCH).
     *   - Optimistic If-Match required on the plan version.
     *   - State machine: approval_requested|approved -> executing -> applied
     *     (all internal_safe steps completed) | partially_applied (any step
     *     skipped/failed). Non-internal_safe steps are skipped with a stable
     *     LIVE_EXECUTION_DISABLED error code while capability.apply.live is OFF.
     *   - All effects (plan + step transitions + audit events) run inside one
     *     DB transaction so partial state cannot leak.
     *   - The stub executor never performs external network/MCP calls; the
     *     real adapter is never instantiated while live OFF.
     */
    async executePlan(
      planId: string,
      companyId: string,
      agentId: string,
      actor: { userId?: string; agentId?: string; runId?: string },
      ifMatchVersion: number,
    ): Promise<CapabilityApplyPlanSummary> {
      return db.transaction(async (tx) => {
        // Lock the plan row for the duration of the transaction so concurrent
        // executes cannot both pass the state check.
        await tx.execute(
          sql`select 1 from ${capabilityApplyPlans} where ${capabilityApplyPlans.id} = ${planId} for update`,
        );
        const [row] = await tx
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
        if (TERMINAL_OR_POST_EXECUTE_STATES.includes(row.state as CapabilityApplyPlanState)) {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED, {
            code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED,
            currentState: row.state,
          });
        }
        if (!EXECUTE_ALLOWED_PRIOR_STATES.includes(row.state as CapabilityApplyPlanState)) {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED, {
            code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED,
            currentState: row.state,
          });
        }
        if (!row.approvalId) {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED, {
            code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED,
            reason: "no_approval_bound",
          });
        }

        const [approval] = await tx
          .select()
          .from(approvals)
          .where(and(eq(approvals.id, row.approvalId), eq(approvals.companyId, companyId)))
          .limit(1);

        if (!approval) {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED, {
            code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED,
            reason: "approval_missing",
          });
        }

        if (approval.status === "rejected") {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED, {
            code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED,
            approvalStatus: approval.status,
          });
        }
        if (approval.status === "cancelled") {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED, {
            code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_CONSUMED,
            approvalStatus: approval.status,
          });
        }
        if (approval.status !== "approved") {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED, {
            code: CAPABILITY_APPLY_ERROR_CODES.APPROVAL_NOT_ACCEPTED,
            approvalStatus: approval.status,
          });
        }

        const approvalPayload = approval.payload as Partial<CapabilityApplyApprovalPayload> | null;
        if (!approvalPayload || approvalPayload.dryRunHash !== row.dryRunHash) {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH, {
            code: CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH,
          });
        }
        if (approvalPayload.planRevisionId !== row.id) {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH, {
            code: CAPABILITY_APPLY_ERROR_CODES.PLAN_HASH_MISMATCH,
            reason: "plan_revision_mismatch",
          });
        }

        // Atomic transition to executing. The `state IN (...)` clause combined
        // with the optimistic version check makes a second concurrent execute
        // either trip OPTIMISTIC_CONFLICT or APPROVAL_CONSUMED.
        const [executingPlan] = await tx
          .update(capabilityApplyPlans)
          .set({
            state: "executing",
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

        if (!executingPlan) {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT, {
            code: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
          });
        }

        const eventCtxBase: EventContext = {
          companyId,
          agentId: row.agentId,
          planId: row.id,
          dryRunHash: row.dryRunHash,
          actorUserId: actor.userId,
          actorAgentId: actor.agentId,
          runId: actor.runId,
        };

        await recordEvent(tx, eventCtxBase, "capability_apply_execute_started", {
          liveExecutionFlagState: opts.capabilityApplyLive ? "on" : "off",
          approvalId: row.approvalId,
        });

        const stepRows = await tx
          .select()
          .from(capabilityApplySteps)
          .where(eq(capabilityApplySteps.planId, planId))
          .orderBy(capabilityApplySteps.ordinal);

        // Construct the executor adapter. While live OFF this is the stub —
        // a real executor adapter is intentionally NOT wired in this slice
        // and getExecutorAdapter throws if the flag is flipped, so this
        // service is the no-live-action enforcement point.
        const executor = getExecutorAdapter(opts.capabilityApplyLive);

        let completedCount = 0;
        let skippedCount = 0;
        let failedCount = 0;

        for (const step of stepRows) {
          if (step.state !== "pending") {
            // Defensive: a non-pending step at execute time means earlier work
            // has touched this plan. Skip to preserve idempotency.
            skippedCount++;
            continue;
          }

          // Non-internal_safe risk classes never execute while live OFF.
          if (step.riskClass !== "internal_safe") {
            await tx
              .update(capabilityApplySteps)
              .set({
                state: "skipped",
                attempts: step.attempts + 1,
                lastErrorCode: CAPABILITY_APPLY_ERROR_CODES.LIVE_EXECUTION_DISABLED,
                lastErrorMessage: "non-internal_safe step skipped while capability.apply.live=OFF",
                updatedAt: new Date(),
              })
              .where(eq(capabilityApplySteps.id, step.id));

            await recordEvent(
              tx,
              { ...eventCtxBase, stepId: step.id },
              "capability_apply_step_skipped",
              {
                code: CAPABILITY_APPLY_ERROR_CODES.LIVE_EXECUTION_DISABLED,
                riskClass: step.riskClass,
                ordinal: step.ordinal,
                kind: step.kind,
              },
            );
            skippedCount++;
            continue;
          }

          // Mark executing + emit started event.
          await tx
            .update(capabilityApplySteps)
            .set({
              state: "executing",
              attempts: step.attempts + 1,
              updatedAt: new Date(),
            })
            .where(eq(capabilityApplySteps.id, step.id));

          await recordEvent(
            tx,
            { ...eventCtxBase, stepId: step.id },
            "capability_apply_step_started",
            { ordinal: step.ordinal, kind: step.kind, riskClass: step.riskClass },
          );

          try {
            const stepView: CapabilityApplyStep = {
              stepId: `step-${step.ordinal}`,
              ordinal: step.ordinal,
              kind: step.kind as CapabilityApplyStep["kind"],
              target: {
                catalogId: (step.targetRefJson as Record<string, unknown>).catalogId as string | undefined,
                label: ((step.targetRefJson as Record<string, unknown>).label as string) ?? "",
                transport: (step.targetRefJson as Record<string, unknown>).transport as
                  | "stdio"
                  | "sse"
                  | "streamable_http"
                  | undefined,
                namedSecretRefs: (step.expectedNamedSecretsJson as string[]) ?? [],
              },
              riskClass: step.riskClass as CapabilityApplyStep["riskClass"],
              annotations: (step.annotationsJson as Record<string, boolean>) ?? {},
              sideEffects: [],
              secretSummary: [],
              state: "executing",
            };
            const result = await executor.executeStep(stepView, row.id);

            await tx
              .update(capabilityApplySteps)
              .set({ state: "completed", updatedAt: new Date() })
              .where(eq(capabilityApplySteps.id, step.id));

            await recordEvent(
              tx,
              { ...eventCtxBase, stepId: step.id },
              "capability_apply_step_completed",
              {
                ordinal: step.ordinal,
                kind: step.kind,
                wouldExecute: result.wouldExecute,
                liveExecutionFlagState: opts.capabilityApplyLive ? "on" : "off",
              },
            );
            completedCount++;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await tx
              .update(capabilityApplySteps)
              .set({
                state: "failed",
                lastErrorCode: "step_execution_failed",
                lastErrorMessage: message.slice(0, 1024),
                updatedAt: new Date(),
              })
              .where(eq(capabilityApplySteps.id, step.id));

            await recordEvent(
              tx,
              { ...eventCtxBase, stepId: step.id },
              "capability_apply_step_failed",
              {
                ordinal: step.ordinal,
                kind: step.kind,
                errorCode: "step_execution_failed",
              },
            );
            failedCount++;
          }
        }

        const terminalState: CapabilityApplyPlanState =
          failedCount === 0 && skippedCount === 0 ? "applied" : "partially_applied";

        const [finalPlan] = await tx
          .update(capabilityApplyPlans)
          .set({
            state: terminalState,
            optimisticVersion: executingPlan.optimisticVersion + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(capabilityApplyPlans.id, planId),
              eq(capabilityApplyPlans.optimisticVersion, executingPlan.optimisticVersion),
            ),
          )
          .returning();

        if (!finalPlan) {
          throw conflict(CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT, {
            code: CAPABILITY_APPLY_ERROR_CODES.OPTIMISTIC_CONFLICT,
            phase: "execute_finalize",
          });
        }

        await recordEvent(
          tx,
          eventCtxBase,
          terminalState === "applied"
            ? "capability_apply_plan_completed"
            : "capability_apply_plan_partially_applied",
          {
            terminalState,
            completedCount,
            skippedCount,
            failedCount,
            stepCount: stepRows.length,
          },
        );

        return planRowToSummary(finalPlan);
      });
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

    stubExecutor: () => getExecutorAdapter(opts.capabilityApplyLive),
  };
}
