import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  createStandupActionSchema,
  disableStandupPolicySchema,
  evaluateStandupSlaSchema,
  inspectStandupSchema,
  manualStandupFireSchema,
  processStandupOutboxSchema,
  replayStandupOutboxJobSchema,
  submitStandupResponseSchema,
  upsertStandupPolicySchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { accessService, standupService } from "../services/index.js";
import { forbidden, notFound, unauthorized } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";

type StandupService = ReturnType<typeof standupService>;
type StandupInspection = Awaited<ReturnType<StandupService["inspect"]>>;
type StandupOutboxJob = Awaited<ReturnType<StandupService["getOutboxJob"]>>;
type ExistingStandupOutboxJob = NonNullable<StandupOutboxJob>;

function assertAuthenticated(req: Request) {
  if (req.actor.type === "none") throw unauthorized();
}

function actorUserId(req: Request) {
  return req.actor.type === "board" ? req.actor.userId ?? "board" : null;
}

async function assertStandupOperator(
  req: Request,
  companyId: string,
  access: ReturnType<typeof accessService>,
) {
  assertCompanyAccess(req, companyId);
  if (req.actor.type !== "board") {
    throw forbidden("Standup operator board access required");
  }
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  const allowed = await access.canUser(companyId, req.actor.userId, "tasks:assign");
  if (!allowed) {
    throw forbidden("Missing permission: tasks:assign");
  }
}

function assertAgentResponseActor(req: Request, actorRunId: string) {
  if (req.actor.type !== "agent" || !req.actor.agentId) {
    throw unauthorized("Agent authentication required");
  }
  const authenticatedRunId = req.actor.runId?.trim();
  if (!authenticatedRunId) {
    throw unauthorized("Agent run id required");
  }
  if (authenticatedRunId !== actorRunId) {
    throw forbidden("Actor run id must match authenticated agent run");
  }
  return req.actor.agentId;
}

function companyIdFromInspection(inspection: StandupInspection) {
  return (
    inspection.session?.companyId ??
    inspection.policy?.companyId ??
    inspection.participants[0]?.companyId ??
    inspection.responses[0]?.companyId ??
    inspection.actions[0]?.companyId ??
    inspection.escalations[0]?.companyId ??
    inspection.outboxJobs[0]?.companyId ??
    inspection.deadLetters[0]?.companyId ??
    null
  );
}

function assertInspectionAccess(req: Request, inspection: StandupInspection) {
  const companyId = companyIdFromInspection(inspection);
  if (companyId) {
    assertCompanyAccess(req, companyId);
    return;
  }
  assertAuthenticated(req);
}

function redactedReplayReceipt(job: NonNullable<StandupOutboxJob>) {
  return {
    id: job.id,
    companyId: job.companyId,
    sessionId: job.sessionId,
    participantId: job.participantId,
    actionId: job.actionId,
    escalationId: job.escalationId,
    serviceRunId: job.serviceRunId,
    jobType: job.jobType,
    status: job.status,
    priority: job.priority,
    targetKind: job.targetKind,
    targetId: job.targetId,
    idempotencyKey: job.idempotencyKey,
    replayOfJobId: job.replayOfJobId,
    createdAt: job.createdAt,
    nextAttemptAt: job.nextAttemptAt,
  };
}

function redactedProcessReceipt(job: ExistingStandupOutboxJob) {
  return {
    id: job.id,
    companyId: job.companyId,
    sessionId: job.sessionId,
    participantId: job.participantId,
    actionId: job.actionId,
    escalationId: job.escalationId,
    serviceRunId: job.serviceRunId,
    jobType: job.jobType,
    status: job.status,
    priority: job.priority,
    targetKind: job.targetKind,
    targetId: job.targetId,
    attempts: job.attempts,
    deliveredAt: job.deliveredAt,
    deadLetteredAt: job.deadLetteredAt,
    lastError: job.lastError,
    nextAttemptAt: job.nextAttemptAt,
    idempotencyKey: job.idempotencyKey,
    replayOfJobId: job.replayOfJobId,
  };
}

export function standupRoutes(db: Db) {
  const router = Router();
  const svc = standupService(db);
  const access = accessService(db);

  async function inspectSessionForOperator(req: Request, sessionId: string) {
    const inspection = await svc.inspect({ sessionId });
    const companyId = companyIdFromInspection(inspection);
    if (!companyId) throw notFound("Standup session not found");
    await assertStandupOperator(req, companyId, access);
    return inspection;
  }

  router.get("/companies/:companyId/standup-policies/:policyKey", async (req, res) => {
    const companyId = req.params.companyId as string;
    const policyKey = req.params.policyKey as string;
    const standupType = typeof req.query.standupType === "string" ? req.query.standupType : "daily";
    assertCompanyAccess(req, companyId);
    const policy = await svc.getPolicy(companyId, policyKey, standupType);
    if (!policy) {
      res.status(404).json({ error: "Standup policy not found" });
      return;
    }
    res.json(policy);
  });

  router.post("/companies/:companyId/standup-policies", validate(upsertStandupPolicySchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertStandupOperator(req, companyId, access);
    const policy = await svc.upsertPolicy(companyId, req.body, {
      userId: actorUserId(req),
    });
    res.status(201).json(policy);
  });

  router.post(
    "/companies/:companyId/standup-policies/disable",
    validate(disableStandupPolicySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertStandupOperator(req, companyId, access);
      const policy = await svc.disablePolicy(companyId, req.body);
      res.json(policy);
    },
  );

  router.post("/companies/:companyId/standups/fire", validate(manualStandupFireSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertStandupOperator(req, companyId, access);
    const inspection = await svc.fireStandup(companyId, {
      ...req.body,
      triggerSource: "api",
    });
    res.status(202).json(inspection);
  });

  router.post("/standups/responses", validate(submitStandupResponseSchema), async (req, res) => {
    const agentId = assertAgentResponseActor(req, req.body.actorRunId);
    const response = await svc.submitResponse(req.body, { agentId });
    res.status(201).json(response);
  });

  router.post("/standups/actions", validate(createStandupActionSchema), async (req, res) => {
    await inspectSessionForOperator(req, req.body.sessionId);
    const action = await svc.createAction(req.body);
    res.status(201).json(action);
  });

  router.post("/standups/sla/evaluate", validate(evaluateStandupSlaSchema), async (req, res) => {
    await inspectSessionForOperator(req, req.body.sessionId);
    const inspection = await svc.evaluateSla(req.body);
    res.json(inspection);
  });

  router.post("/standups/inspect", validate(inspectStandupSchema), async (req, res) => {
    if (req.body.companyId) {
      assertCompanyAccess(req, req.body.companyId);
    }
    const inspection = await svc.inspect(req.body);
    assertInspectionAccess(req, inspection);
    res.json(inspection);
  });

  router.post("/standups/outbox/replay", validate(replayStandupOutboxJobSchema), async (req, res) => {
    const job = await svc.getOutboxJob(req.body.jobId);
    if (!job) throw notFound("Standup outbox job not found");
    await assertStandupOperator(req, job.companyId, access);
    const replay = await svc.replayOutboxJob(req.body);
    res.status(201).json(redactedReplayReceipt(replay));
  });

  router.post("/standups/outbox/process", validate(processStandupOutboxSchema), async (req, res) => {
    const companyId = req.body.companyId as string;
    await assertStandupOperator(req, companyId, access);
    if (req.body.sessionId) {
      const inspection = await svc.inspect({ sessionId: req.body.sessionId });
      const inspectedCompanyId = companyIdFromInspection(inspection);
      if (!inspectedCompanyId) throw notFound("Standup session not found");
      if (inspectedCompanyId !== companyId) throw forbidden("Standup session belongs to a different company");
    }
    const processed = await svc.processOutbox({
      companyId,
      sessionId: req.body.sessionId,
      serviceRunId: req.body.serviceRunId,
      limit: req.body.limit,
      now: req.body.now ? new Date(req.body.now) : undefined,
      deliver: svc.deliverIssueAssignment,
    });
    res.json({
      companyId,
      sessionId: req.body.sessionId ?? null,
      serviceRunId: req.body.serviceRunId,
      processedCount: processed.length,
      processed: processed.map(redactedProcessReceipt),
    });
  });

  return router;
}
