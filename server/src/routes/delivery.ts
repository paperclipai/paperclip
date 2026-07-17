import { Router, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  DELIVERY_STAGES,
  createDeliveryControlUpdateSchema,
  createDeliveryEventSchema,
  createExternalOperationSchema,
  issueExecutionPolicySchema,
  issueExecutionStateSchema,
  legacyDeliveryBackfillSchema,
  updateExternalOperationSchema,
  type DeliveryFactoryProvenanceV1,
  type DeliverySnapshotV1,
  type DeliveryStage,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  accessService,
  candidateShasMatch,
  deliveryService,
  issueVisibilityService,
  issueService,
  issueTreeControlService,
  logActivity,
  type DeliveryActor,
} from "../services/index.js";
import { conflict, forbidden, unauthorized, unprocessable } from "../errors.js";
import {
  assertBoard,
  assertCompanyAccess,
  getActorInfo,
  requirePermissionOrProjectPermission,
  requireProjectAccess,
} from "./authz.js";

const FACTORY_STAGE_DELIVERY_STAGES: Readonly<Record<string, readonly DeliveryStage[]>> = {
  contract: [],
  implementation: ["implementation", "ci"],
  independent_qa: ["functional_qa"],
  technical_acceptance: ["technical_acceptance"],
  deployment: ["deployment"],
  live_qa: ["smoke"],
  final_acceptance: ["business_acceptance"],
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sameFactoryParticipant(
  actor: ReturnType<typeof getActorInfo>,
  participant: { type: "agent" | "user"; agentId?: string | null; userId?: string | null },
) {
  return participant.type === "agent"
    ? actor.actorType === "agent" && actor.agentId === participant.agentId
    : actor.actorType === "user" && actor.actorId === participant.userId;
}

function deliveryActor(req: Request): DeliveryActor {
  const actor = getActorInfo(req);
  return actor.actorType === "agent"
    ? { actorType: "agent", agentId: actor.agentId, runId: actor.runId }
    : { actorType: "user", userId: actor.actorId, runId: actor.runId };
}

function markdownCell(value: string | null | undefined) {
  if (!value) return "—";
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").slice(0, 500);
}

function stageLabel(stage: string) {
  return stage.split("_").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

/** Server-owned rendering keeps ledger facts out of generated prose. */
export function renderDeliveryControlUpdate(snapshot: DeliverySnapshotV1, note?: string | null) {
  const rows = DELIVERY_STAGES.map((stage) => {
    const value = snapshot.stages[stage];
    const evidence = value.providerUrl
      ? `${markdownCell(value.provider ?? "provider")} — ${markdownCell(value.providerUrl)}`
      : markdownCell(value.provider ?? value.providerExternalId);
    return `| ${stageLabel(stage)} | ${value.state} | ${markdownCell(value.authority)} | ${evidence} |`;
  });
  const factualBlock = [
    `<!-- paperclip:delivery-snapshot revision=${snapshot.revision} -->`,
    "### Delivery status — authoritative snapshot",
    "",
    `- Candidate: ${markdownCell(snapshot.candidateSha)}`,
    `- Environment: ${markdownCell(snapshot.environment)}`,
    `- Evidence events: ${snapshot.watermark.eventCount}`,
    "",
    "| Stage | State | Authority | Evidence |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `Snapshot revision: \`${snapshot.revision}\``,
  ];
  const advisory = note?.trim()
    ? ["", "### Note — advisory, not delivery evidence", "", note.trim()]
    : [];
  return [...factualBlock, ...advisory].join("\n");
}

function factoryAgentCanPublishControlUpdate(issue: Awaited<ReturnType<ReturnType<typeof issueService>["getById"]>>, agentId: string) {
  if (!issue) return false;
  if (issue.assigneeAgentId === agentId) return true;
  const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
  if (policy.success && policy.data.factory?.coordinator.type === "agent") {
    if (policy.data.factory.coordinator.agentId === agentId) return true;
  }
  const state = issueExecutionStateSchema.safeParse(issue.executionState);
  return state.success
    && state.data.currentParticipant?.type === "agent"
    && state.data.currentParticipant.agentId === agentId;
}

export function deliveryRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const delivery = deliveryService(db);
  const treeControl = issueTreeControlService(db);
  const access = accessService(db);
  const visibility = issueVisibilityService(db);

  async function loadIssue(req: Request) {
    const issue = await issuesSvc.getById(req.params.id as string);
    if (!issue) return null;
    if (issue.projectId) {
      await requireProjectAccess(req, access, issue.companyId, issue.projectId);
    } else {
      assertCompanyAccess(req, issue.companyId);
    }
    if (issue.visibility === "private") {
      const principal = req.actor.type === "agent"
        ? { kind: "agent" as const, agentId: req.actor.agentId ?? "" }
        : req.actor.type === "board" && req.actor.source === "local_implicit"
          ? { kind: "system" as const }
          : {
              kind: "user" as const,
              userId: req.actor.type === "board" ? req.actor.userId ?? "" : "",
              isInstanceAdmin: req.actor.type === "board" && Boolean(req.actor.isInstanceAdmin),
            };
      if (!(await visibility.canSeeIssue(principal, issue))) return null;
    }
    return issue;
  }

  async function assertNoActiveHold(issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>) {
    const pauseHold = await treeControl.getActivePauseHoldGate(issue.companyId, issue.id);
    if (pauseHold) {
      throw conflict("This issue is paused by an active tree hold.", {
        code: "issue_tree_paused",
        holdId: pauseHold.holdId,
        rootIssueId: pauseHold.rootIssueId,
      });
    }
    const cancelHold = await treeControl.getActiveCancelHoldGate(issue.companyId, issue.id);
    if (cancelHold) {
      throw conflict("This issue is cancelled by an active tree hold.", {
        code: "issue_tree_cancelled",
        holdId: cancelHold.holdId,
        rootIssueId: cancelHold.rootIssueId,
      });
    }
  }

  async function assertBoardDeliveryPermission(
    req: Request,
    issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>,
  ) {
    assertBoard(req);
    await requirePermissionOrProjectPermission(
      req,
      access,
      issue.companyId,
      "issues:manage",
      issue.projectId,
      "project:issues:edit",
    );
  }

  async function assertActiveAgentRun(
    req: Request,
    issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>,
  ) {
    if (req.actor.type !== "agent") return;
    const actor = getActorInfo(req);
    if (!actor.agentId) throw forbidden("Agent authentication required");
    if (!actor.runId) throw unauthorized("Agent run id required");
    const run = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.id, actor.runId),
        eq(heartbeatRuns.companyId, issue.companyId),
        eq(heartbeatRuns.agentId, actor.agentId),
        eq(heartbeatRuns.status, "running"),
      ))
      .then((rows) => rows[0] ?? null);
    const context = asRecord(run?.contextSnapshot);
    if (!run || ![context.issueId, context.taskId, context.sourceIssueId].includes(issue.id)) {
      throw forbidden("The active agent run is not scoped to this issue");
    }
  }

  async function factoryDeliveryContext(
    req: Request,
    issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>,
    deliveryStage: DeliveryStage,
    candidateSha: string | null | undefined,
  ): Promise<DeliveryFactoryProvenanceV1 | null> {
    const parsedPolicy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
    if (!parsedPolicy.success || !parsedPolicy.data.factory) return null;
    if (parsedPolicy.data.factory.laneKind !== "execution") {
      throw forbidden("Delivery evidence belongs on an AI Factory execution lane, not its control issue");
    }
    const parsedState = issueExecutionStateSchema.safeParse(issue.executionState);
    if (!parsedState.success) {
      throw conflict("The AI Factory lane has no valid active execution state", {
        code: "factory_delivery_context_conflict",
      });
    }
    const state = parsedState.data;
    const stage = parsedPolicy.data.stages.find((candidate) => candidate.id === state.currentStageId);
    const participant = state.currentParticipant;
    if (
      !stage
      || !stage.id
      || !participant
      || state.status === "idle"
      || state.status === "completed"
      || state.stageRevision < 1
      || !state.currentStageActivatedAt
    ) {
      throw conflict("The AI Factory lane has no active stage revision", {
        code: "factory_delivery_context_conflict",
      });
    }
    const actor = getActorInfo(req);
    if (!sameFactoryParticipant(actor, participant)) {
      throw forbidden("Only the active AI Factory stage participant can record its delivery evidence");
    }
    const allowedStages = stage.key ? FACTORY_STAGE_DELIVERY_STAGES[stage.key] : undefined;
    if (!allowedStages?.includes(deliveryStage)) {
      throw unprocessable("This delivery evidence stage is not owned by the active AI Factory stage", {
        code: "factory_delivery_stage_forbidden",
        factoryStageId: stage.id,
        factoryStageKey: stage.key ?? null,
        deliveryStage,
      });
    }
    if (!candidateSha) {
      throw unprocessable("AI Factory delivery evidence requires a candidate SHA", {
        code: "factory_candidate_required",
      });
    }
    const establishesCandidate = stage.key === "implementation" && deliveryStage === "implementation";
    if (!establishesCandidate) {
      const snapshot = await delivery.getSnapshot(issue.companyId, issue.id);
      if (!snapshot.candidateSha || !candidateShasMatch(snapshot.candidateSha, candidateSha)) {
        throw conflict("AI Factory delivery evidence does not match the implementation candidate", {
          code: "factory_candidate_conflict",
          expectedCandidateSha: snapshot.candidateSha,
          suppliedCandidateSha: candidateSha,
        });
      }
    }
    return {
      version: 1,
      stageId: stage.id,
      stageKey: stage.key ?? null,
      stageRevision: state.stageRevision,
      stageActivatedAt: state.currentStageActivatedAt,
      participant: {
        type: participant.type,
        agentId: participant.type === "agent" ? participant.agentId ?? null : null,
        userId: participant.type === "user" ? participant.userId ?? null : null,
      },
    };
  }

  async function assertDeliveryMutationAllowed(
    req: Request,
    issue: NonNullable<Awaited<ReturnType<typeof loadIssue>>>,
    deliveryStage: DeliveryStage,
    candidateSha: string | null | undefined,
  ) {
    await assertNoActiveHold(issue);
    if (req.actor.type === "board") {
      await assertBoardDeliveryPermission(req, issue);
    } else {
      await assertActiveAgentRun(req, issue);
      const actor = getActorInfo(req);
      const policy = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
      if (
        (!policy.success || !policy.data.factory)
        && (!actor.agentId || !factoryAgentCanPublishControlUpdate(issue, actor.agentId))
      ) {
        throw forbidden("Only the assigned issue agent can mutate delivery state");
      }
    }
    return factoryDeliveryContext(req, issue, deliveryStage, candidateSha);
  }

  router.get("/issues/:id/delivery-snapshot", async (req, res) => {
    const issue = await loadIssue(req);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json(await delivery.getSnapshot(issue.companyId, issue.id));
  });

  router.post(
    "/issues/:id/control-updates",
    validate(createDeliveryControlUpdateSchema),
    async (req, res) => {
      const issue = await loadIssue(req);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      const actor = getActorInfo(req);
      if (actor.actorType === "agent") {
        await assertActiveAgentRun(req, issue);
        if (!actor.agentId || !factoryAgentCanPublishControlUpdate(issue, actor.agentId)) {
          throw forbidden("Only the assigned factory participant or lane coordinator can publish a control update");
        }
      } else {
        await assertBoardDeliveryPermission(req, issue);
      }
      await assertNoActiveHold(issue);

      const { snapshot, comment } = await delivery.withIssueDeliveryLock(
        issue.companyId,
        issue.id,
        async () => {
          await assertNoActiveHold(issue);
          const lockedSnapshot = await delivery.getSnapshot(issue.companyId, issue.id);
          if (lockedSnapshot.revision !== req.body.snapshotRevision) {
            throw conflict("Delivery evidence changed; refresh the snapshot before publishing the control update.", {
              code: "delivery_snapshot_conflict",
              suppliedRevision: req.body.snapshotRevision,
              currentRevision: lockedSnapshot.revision,
            });
          }
          const lockedComment = await issuesSvc.addComment(
            issue.id,
            renderDeliveryControlUpdate(lockedSnapshot, req.body.note ?? null),
            {
              agentId: actor.agentId ?? undefined,
              userId: actor.actorType === "user" ? actor.actorId : undefined,
              runId: actor.runId,
            },
          );
          return { snapshot: lockedSnapshot, comment: lockedComment };
        },
      );
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.delivery_control_update_published",
        entityType: "issue",
        entityId: issue.id,
        details: {
          commentId: comment.id,
          snapshotRevision: snapshot.revision,
          candidateSha: snapshot.candidateSha,
          eventCount: snapshot.watermark.eventCount,
        },
      });
      res.status(201).json({ comment, snapshot });
    },
  );

  router.get("/issues/:id/delivery-events", async (req, res) => {
    const issue = await loadIssue(req);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json(await delivery.listEvents(issue.companyId, issue.id));
  });

  router.post("/issues/:id/delivery-events", validate(createDeliveryEventSchema), async (req, res) => {
    const issue = await loadIssue(req);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const factoryProvenance = await assertDeliveryMutationAllowed(
      req,
      issue,
      req.body.stage,
      req.body.candidateSha,
    );
    const actor = getActorInfo(req);
    const result = actor.actorType === "agent"
      ? await delivery.appendAgentClaim(
          issue.companyId,
          issue.id,
          req.body,
          deliveryActor(req),
          factoryProvenance,
        )
      : await delivery.appendUserAssertion(
          issue.companyId,
          issue.id,
          req.body,
          deliveryActor(req),
          factoryProvenance,
        );
    if (result.created) {
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.delivery_event_recorded",
        entityType: "issue",
        entityId: issue.id,
        details: {
          eventId: result.event.id,
          stage: result.event.stage,
          state: result.event.state,
          authority: result.event.authority,
          sourceKind: result.event.sourceKind,
        },
      });
    }
    res.status(result.created ? 201 : 200).json(result.event);
  });

  router.post(
    "/issues/:id/delivery-events/backfill-legacy",
    validate(legacyDeliveryBackfillSchema),
    async (req, res) => {
      assertBoard(req);
      const issue = await loadIssue(req);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      await assertBoardDeliveryPermission(req, issue);
      await assertNoActiveHold(issue);
      const result = await delivery.backfillLegacyWorkProducts(
        issue.companyId,
        issue.id,
        req.body.workProductIds,
      );
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.delivery_legacy_backfilled",
        entityType: "issue",
        entityId: issue.id,
        details: { inspected: result.inspected, appended: result.appended.length },
      });
      res.json(result);
    },
  );

  router.get("/issues/:id/external-operations", async (req, res) => {
    const issue = await loadIssue(req);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    res.json(await delivery.listExternalOperations(issue.companyId, issue.id));
  });

  router.post(
    "/issues/:id/external-operations",
    validate(createExternalOperationSchema),
    async (req, res) => {
      const issue = await loadIssue(req);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      const factoryProvenance = await assertDeliveryMutationAllowed(
        req,
        issue,
        req.body.stage,
        req.body.candidateSha,
      );
      const result = await delivery.createExternalOperation(
        issue.companyId,
        issue.id,
        req.body,
        deliveryActor(req),
        factoryProvenance,
      );
      if (result.created) {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId: issue.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.external_operation_created",
          entityType: "issue",
          entityId: issue.id,
          details: {
            operationId: result.operation.id,
            kind: result.operation.kind,
            provider: result.operation.provider,
            externalId: result.operation.externalId,
          },
        });
      }
      res.status(result.created ? 201 : 200).json(result.operation);
    },
  );

  router.patch(
    "/issues/:id/external-operations/:operationId",
    validate(updateExternalOperationSchema),
    async (req, res) => {
      const issue = await loadIssue(req);
      if (!issue) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }
      const existing = await delivery.getExternalOperation(
        issue.companyId,
        issue.id,
        req.params.operationId as string,
      );
      if (!existing) {
        res.status(404).json({ error: "External operation not found" });
        return;
      }
      await assertDeliveryMutationAllowed(req, issue, existing.stage, existing.candidateSha);
      const operation = await delivery.updateExternalOperation(
        issue.companyId,
        issue.id,
        req.params.operationId as string,
        req.body,
      );
      if (!operation) {
        res.status(404).json({ error: "External operation not found" });
        return;
      }
      const actor = getActorInfo(req);
      await logActivity(db, {
        companyId: issue.companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "issue.external_operation_updated",
        entityType: "issue",
        entityId: issue.id,
        details: { operationId: operation.id, changedKeys: Object.keys(req.body).sort() },
      });
      res.json(operation);
    },
  );

  router.post("/issues/:id/external-operations/:operationId/verify", async (req, res) => {
    const issue = await loadIssue(req);
    if (!issue) {
      res.status(404).json({ error: "Issue not found" });
      return;
    }
    const previous = await delivery.getExternalOperation(
      issue.companyId,
      issue.id,
      req.params.operationId as string,
    );
    if (!previous) {
      res.status(404).json({ error: "External operation not found" });
      return;
    }
    await assertDeliveryMutationAllowed(req, issue, previous.stage, previous.candidateSha);
    const result = await delivery.verifyExternalOperation(
      issue.companyId,
      issue.id,
      req.params.operationId as string,
      deliveryActor(req),
    );
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: issue.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      action: "issue.external_operation_verified",
      entityType: "issue",
      entityId: issue.id,
      details: {
        operationId: result.operation.id,
        provider: result.operation.provider,
        previousState: previous?.state ?? null,
        state: result.operation.state,
        verificationStatus: result.operation.verificationStatus,
        providerEventId: result.event.id,
        eventCreated: result.eventCreated,
        candidateMismatch: result.candidateMismatch,
      },
    });
    res.json(result);
  });

  return router;
}
