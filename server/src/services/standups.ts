import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  heartbeatRuns,
  issues,
  standupActions,
  standupDeadLetters,
  standupEscalations,
  standupOutboxJobs,
  standupParticipants,
  standupPolicies,
  standupResponses,
  standupSessions,
  routines,
} from "@paperclipai/db";
import type {
  CreateStandupAction,
  DisableStandupPolicy,
  EvaluateStandupSla,
  InspectStandup,
  ManualStandupFire,
  ProcessStandupOutbox,
  ReplayStandupOutboxJob,
  StandupResponseBody,
  SubmitStandupResponse,
  UpsertStandupPolicy,
} from "@paperclipai/shared";
import { standupResponseBodySchema } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { validateCron } from "./cron.js";

type DbOrTx = Db | any;

type Actor = {
  agentId?: string | null;
  userId?: string | null;
};

type FireStandupInput = ManualStandupFire & {
  routineId?: string | null;
  triggerId?: string | null;
  routineRunId?: string | null;
  triggerSource?: "manual" | "schedule" | "api" | "webhook";
};

type OutboxProcessInput = Partial<Pick<ProcessStandupOutbox, "companyId" | "sessionId" | "serviceRunId">> & {
  now?: Date;
  limit?: number;
  deliver?: (job: typeof standupOutboxJobs.$inferSelect) => Promise<OutboxDeliveryResult> | OutboxDeliveryResult;
};

type OutboxDeliveryResult = {
  ok: boolean;
  proofId?: string | null;
  error?: string | null;
  retryAt?: Date | null;
};

type StandupOutboxJob = typeof standupOutboxJobs.$inferSelect;

type IssueInsert = {
  projectId?: string | null;
  goalId?: string | null;
  parentId?: string | null;
  title: string;
  description?: string | null;
  status?: string;
  priority?: string;
  assigneeAgentId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  originKind?: string;
  originId?: string | null;
  originRunId?: string | null;
};

type StandupInspection = {
  policy: typeof standupPolicies.$inferSelect | null;
  session: typeof standupSessions.$inferSelect | null;
  participants: Array<typeof standupParticipants.$inferSelect>;
  responses: Array<typeof standupResponses.$inferSelect>;
  actions: Array<typeof standupActions.$inferSelect>;
  escalations: Array<typeof standupEscalations.$inferSelect>;
  outboxJobs: Array<typeof standupOutboxJobs.$inferSelect>;
  deadLetters: Array<typeof standupDeadLetters.$inferSelect>;
  standup_forced: boolean;
  action_taken: boolean;
  car_still_non_green: boolean;
  partial_failure: boolean;
  missing_evidence: string[];
};

function assertTimeZone(timeZone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw unprocessable(`Invalid timezone: ${timeZone}`);
  }
}

function localDateFor(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function wallTimeToDate(localDate: string, localTime: string, timeZone: string) {
  const [year, month, day] = localDate.split("-").map(Number);
  const [hour, minute] = localTime.split(":").map(Number);
  let candidate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  for (let i = 0; i < 3; i += 1) {
    const parts = formatter.formatToParts(candidate);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const actualAsUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour),
      Number(map.minute),
      0,
      0,
    );
    const diff = desiredAsUtc - actualAsUtc;
    if (diff === 0) break;
    candidate = new Date(candidate.getTime() + diff);
  }

  return candidate;
}

function findErrorRecord(error: unknown, predicate: (record: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  let current = error;
  while (current && typeof current === "object") {
    const record = current as Record<string, unknown>;
    if (predicate(record)) return record;
    current = record.cause;
  }
  return null;
}

function uniqueConstraintName(error: unknown) {
  const record = findErrorRecord(error, (candidate) =>
    candidate.code === "23505" &&
    (typeof candidate.constraint === "string" || typeof candidate.constraint_name === "string"),
  );
  if (!record) return null;
  return typeof record.constraint === "string"
    ? record.constraint
    : typeof record.constraint_name === "string"
      ? record.constraint_name
      : null;
}

function isUniqueConstraint(error: unknown, constraint: string) {
  return uniqueConstraintName(error) === constraint;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValueIncludesDenylist(value: unknown, denylist: string[]) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return denylist.some((entry) => normalized.includes(entry.trim().toLowerCase()));
}

function responseHasGenericAnswer(response: StandupResponseBody, denylist: string[]) {
  if (denylist.length === 0) return false;
  return Object.values(response).some((value) => stringValueIncludesDenylist(value, denylist));
}

const ACCEPTABLE_ACTION_TIMING_STATES = new Set([
  "by_12_local",
  "by_12_america_chicago",
  "before_noon_local",
  "due_before_next_standup",
  "before_next_standup",
]);

function actionHasTimelyProof(action: typeof standupActions.$inferSelect) {
  return ACCEPTABLE_ACTION_TIMING_STATES.has(action.timingState.trim().toLowerCase());
}

function participantHasDirectiveDelivery(
  participant: typeof standupParticipants.$inferSelect,
  deliveredDirectiveParticipantIds: Set<string>,
) {
  return (
    !!participant.directiveIssueId &&
    (participant.deliveryStatus === "delivered" || deliveredDirectiveParticipantIds.has(participant.id))
  );
}

function actionHasDeliveryReceipt(
  action: typeof standupActions.$inferSelect,
  outboxJobs: Array<typeof standupOutboxJobs.$inferSelect>,
) {
  return outboxJobs.some((job) =>
    job.actionId === action.id &&
    job.jobType === "action_wakeup" &&
    job.status === "succeeded" &&
    !!job.deliveredAt,
  );
}

function responseSchemaRejectedReason(response: unknown, responseSchema: Record<string, unknown>) {
  const parsed = standupResponseBodySchema.safeParse(response);
  if (!parsed.success) return "response_schema_invalid";

  const required = Array.isArray(responseSchema.required)
    ? responseSchema.required.filter((field): field is string => typeof field === "string" && field.trim().length > 0)
    : [];
  const responseRecord = parsed.data as Record<string, unknown>;
  const missing = required.filter((field) => {
    const value = responseRecord[field];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missing.length > 0) return `response_schema_missing:${missing.join(",")}`;
  return null;
}

function responseJsonForStorage(response: unknown) {
  const record = asRecord(response);
  if (Object.keys(record).length > 0) return record;
  return { invalidResponse: response == null ? null : String(response) };
}

function errorMessage(error: unknown) {
  const base = error instanceof Error ? error.message : String(error);
  const constraint = uniqueConstraintName(error);
  return constraint && !base.includes(constraint) ? `${base} (${constraint})` : base;
}

function deliveryProofId(job: typeof standupOutboxJobs.$inferSelect, attempts: number, proofId?: string | null) {
  return proofId?.trim() || `standup_outbox_jobs:${job.id}:attempt:${attempts}`;
}

function payloadIssueId(job: StandupOutboxJob) {
  const payload = job.payload && typeof job.payload === "object" ? job.payload as Record<string, unknown> : {};
  if (job.jobType === "directive_wakeup") return String(payload.directiveIssueId ?? "");
  if (job.jobType === "action_wakeup") return String(payload.issueId ?? "");
  if (job.jobType === "escalation_wakeup") return String(payload.escalationIssueId ?? "");
  return "";
}

function expectedIssueOrigin(job: StandupOutboxJob) {
  if (job.jobType === "directive_wakeup") return "standup_directive";
  if (job.jobType === "action_wakeup") return "standup_action";
  if (job.jobType === "escalation_wakeup") return "standup_escalation";
  return "";
}

function nextRetryAt(now: Date, attempts: number) {
  const delayMs = Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + delayMs);
}

function resolveActingOwnerAgentId(
  policy: typeof standupPolicies.$inferSelect,
  participant: typeof standupParticipants.$inferSelect,
) {
  const routing = asRecord(policy.actionRouting);
  const missingResponse = asRecord(routing.missing_response);
  const configured =
    typeof missingResponse.actingOwnerAgentId === "string"
      ? missingResponse.actingOwnerAgentId
      : typeof missingResponse.ownerAgentId === "string"
        ? missingResponse.ownerAgentId
        : null;
  return configured ?? policy.participantAgentIds.find((id) => id !== participant.agentId) ?? participant.agentId;
}

async function validateServiceRun(dbOrTx: DbOrTx, companyId: string, serviceRunId: string, agentId?: string | null) {
  const run = await dbOrTx
    .select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, serviceRunId))
    .then((rows: Array<{ id: string; companyId: string; agentId: string }>) => rows[0] ?? null);
  if (!run) throw unprocessable("Service run does not exist");
  if (run.companyId !== companyId) throw forbidden("Service run belongs to a different company");
  if (agentId && run.agentId !== agentId) throw forbidden("Service run belongs to a different agent");
  return run;
}

async function assertCompanyAgents(dbOrTx: DbOrTx, companyId: string, agentIds: string[]) {
  const uniqueIds = [...new Set(agentIds)];
  if (uniqueIds.length === 0) throw unprocessable("At least one participant agent is required");
  const rows = await dbOrTx
    .select({ id: agents.id, companyId: agents.companyId, name: agents.name, role: agents.role, status: agents.status })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), inArray(agents.id, uniqueIds)));
  if (rows.length !== uniqueIds.length) throw unprocessable("One or more standup agents do not belong to company");
  const unavailable = rows.find((row: { status: string }) => row.status === "pending_approval" || row.status === "terminated");
  if (unavailable) throw conflict("Standup agent is not available", { agentId: unavailable.id, status: unavailable.status });
  return rows as Array<{ id: string; companyId: string; name: string; role: string; status: string }>;
}

async function assertLinkedRoutine(dbOrTx: DbOrTx, companyId: string, routineId: string | null | undefined) {
  if (!routineId) return null;
  const routine = await dbOrTx
    .select()
    .from(routines)
    .where(eq(routines.id, routineId))
    .then((rows: Array<typeof routines.$inferSelect>) => rows[0] ?? null);
  if (!routine) throw notFound("Linked routine not found");
  if (routine.companyId !== companyId) throw forbidden("Linked routine belongs to a different company");
  return routine;
}

async function createIssueInTx(dbOrTx: DbOrTx, companyId: string, input: IssueInsert) {
  const [company] = await dbOrTx
    .update(companies)
    .set({ issueCounter: sql`${companies.issueCounter} + 1` })
    .where(eq(companies.id, companyId))
    .returning({ issueCounter: companies.issueCounter, issuePrefix: companies.issuePrefix });
  if (!company) throw notFound("Company not found");

  const issueNumber = company.issueCounter;
  const identifier = `${company.issuePrefix}-${issueNumber}`;
  const [issue] = await dbOrTx
    .insert(issues)
    .values({
      companyId,
      projectId: input.projectId ?? null,
      goalId: input.goalId ?? null,
      parentId: input.parentId ?? null,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      createdByAgentId: input.createdByAgentId ?? null,
      createdByUserId: input.createdByUserId ?? null,
      originKind: input.originKind ?? "manual",
      originId: input.originId ?? null,
      originRunId: input.originRunId ?? null,
      issueNumber,
      identifier,
    })
    .returning();
  return issue as typeof issues.$inferSelect;
}

async function getPolicyByKey(dbOrTx: DbOrTx, companyId: string, policyKey: string, standupType = "daily") {
  return dbOrTx
    .select()
    .from(standupPolicies)
    .where(
      and(
        eq(standupPolicies.companyId, companyId),
        eq(standupPolicies.policyKey, policyKey),
        eq(standupPolicies.standupType, standupType),
      ),
    )
    .then((rows: Array<typeof standupPolicies.$inferSelect>) => rows[0] ?? null);
}

function directiveBody(input: {
  policy: typeof standupPolicies.$inferSelect;
  session: typeof standupSessions.$inferSelect;
  agentName: string;
}) {
  return [
    `You are required to answer the ${input.policy.title} standup for ${input.session.localDate}.`,
    "",
    "Your response must include:",
    "- whatHappened",
    "- why",
    "- nextAction",
    "- owner",
    "- dueTime",
    "- proofTarget",
    "- blockerOrAuthorityGap",
    "- immediateActionTaken",
    "",
    `Response due: ${input.session.responseDueAt.toISOString()}`,
    `Escalation due: ${input.session.escalationDueAt.toISOString()}`,
    "",
    "Generic monitoring/status answers do not satisfy this standup.",
  ].join("\n");
}

function actionBody(input: CreateStandupAction) {
  return [
    `Standup action source: ${input.sourceBlockerKey}`,
    "",
    `Due: ${input.dueAt}`,
    `Timing state: ${input.timingState}`,
    "",
    "Proof target:",
    input.proofTarget,
    "",
    "Action payload:",
    JSON.stringify(input.actionJson ?? {}, null, 2),
  ].join("\n");
}

function escalationBody(input: {
  policy: typeof standupPolicies.$inferSelect;
  participant: typeof standupParticipants.$inferSelect;
  reason: string;
  deadlineAt: Date;
  closureCondition: string;
}) {
  return [
    `Escalation for ${input.policy.title}: participant ${input.participant.agentId}`,
    "",
    `Reason: ${input.reason}`,
    `Deadline: ${input.deadlineAt.toISOString()}`,
    "",
    "Closure condition:",
    input.closureCondition,
  ].join("\n");
}

export function standupService(db: Db) {
  async function deliverIssueAssignment(job: StandupOutboxJob): Promise<OutboxDeliveryResult> {
    if (job.targetKind !== "agent") {
      return { ok: false, error: "delivery_target_kind_unsupported" };
    }
    const issueId = payloadIssueId(job);
    if (!issueId) {
      return { ok: false, error: "delivery_issue_id_missing" };
    }
    const [issue] = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        assigneeAgentId: issues.assigneeAgentId,
        originKind: issues.originKind,
        originId: issues.originId,
      })
      .from(issues)
      .where(eq(issues.id, issueId));
    if (!issue) {
      return { ok: false, error: "delivery_issue_missing" };
    }
    if (issue.companyId !== job.companyId) {
      return { ok: false, error: "delivery_issue_company_mismatch" };
    }
    if (issue.assigneeAgentId !== job.targetId) {
      return { ok: false, error: "delivery_issue_assignee_mismatch" };
    }
    const expectedOrigin = expectedIssueOrigin(job);
    if (expectedOrigin && issue.originKind !== expectedOrigin) {
      return { ok: false, error: "delivery_issue_origin_mismatch" };
    }
    if (issue.originId !== job.sessionId) {
      return { ok: false, error: "delivery_issue_session_mismatch" };
    }
    return {
      ok: true,
      proofId: `paperclip_issue_assigned:${issue.identifier}:${job.id}`,
    };
  }

  async function inspect(input: InspectStandup): Promise<StandupInspection> {
    let session: typeof standupSessions.$inferSelect | null = null;
    if (input.sessionId) {
      session = await db
        .select()
        .from(standupSessions)
        .where(eq(standupSessions.id, input.sessionId))
        .then((rows) => rows[0] ?? null);
    } else if (input.companyId && input.policyKey && input.localDate) {
      session = await db
        .select({
          id: standupSessions.id,
          companyId: standupSessions.companyId,
          policyId: standupSessions.policyId,
          routineId: standupSessions.routineId,
          triggerId: standupSessions.triggerId,
          routineRunId: standupSessions.routineRunId,
          serviceRunId: standupSessions.serviceRunId,
          standupIssueId: standupSessions.standupIssueId,
          localDate: standupSessions.localDate,
          standupType: standupSessions.standupType,
          policyVersion: standupSessions.policyVersion,
          timezone: standupSessions.timezone,
          status: standupSessions.status,
          triggerSource: standupSessions.triggerSource,
          idempotencyKey: standupSessions.idempotencyKey,
          triggerConditionSnapshot: standupSessions.triggerConditionSnapshot,
          assessmentSnapshot: standupSessions.assessmentSnapshot,
          manualTriggerReceipt: standupSessions.manualTriggerReceipt,
          partialIssueIds: standupSessions.partialIssueIds,
          responseDueAt: standupSessions.responseDueAt,
          escalationDueAt: standupSessions.escalationDueAt,
          actionDueAt: standupSessions.actionDueAt,
          firedAt: standupSessions.firedAt,
          completedAt: standupSessions.completedAt,
          failureReason: standupSessions.failureReason,
          createdAt: standupSessions.createdAt,
          updatedAt: standupSessions.updatedAt,
        })
        .from(standupSessions)
        .innerJoin(standupPolicies, eq(standupSessions.policyId, standupPolicies.id))
        .where(
          and(
            eq(standupSessions.companyId, input.companyId),
            eq(standupPolicies.companyId, input.companyId),
            eq(standupPolicies.policyKey, input.policyKey),
            eq(standupSessions.localDate, input.localDate),
            eq(standupSessions.standupType, input.standupType ?? "daily"),
          ),
        )
        .then((rows) => rows[0] ?? null);
    }

    if (!session) {
      return {
        policy: null,
        session: null,
        participants: [],
        responses: [],
        actions: [],
        escalations: [],
        outboxJobs: [],
        deadLetters: [],
        standup_forced: false,
        action_taken: false,
        car_still_non_green: false,
        partial_failure: false,
        missing_evidence: ["session"],
      };
    }

    const [policy, participants, responses, actions, escalations, outboxJobs, deadLetters] = await Promise.all([
      db.select().from(standupPolicies).where(eq(standupPolicies.id, session.policyId)).then((rows) => rows[0] ?? null),
      db
        .select()
        .from(standupParticipants)
        .where(eq(standupParticipants.sessionId, session.id))
        .orderBy(asc(standupParticipants.createdAt), asc(standupParticipants.id)),
      db
        .select()
        .from(standupResponses)
        .where(eq(standupResponses.sessionId, session.id))
        .orderBy(asc(standupResponses.submittedAt), asc(standupResponses.id)),
      db
        .select()
        .from(standupActions)
        .where(eq(standupActions.sessionId, session.id))
        .orderBy(asc(standupActions.createdAt), asc(standupActions.id)),
      db
        .select()
        .from(standupEscalations)
        .where(eq(standupEscalations.sessionId, session.id))
        .orderBy(asc(standupEscalations.createdAt), asc(standupEscalations.id)),
      db
        .select()
        .from(standupOutboxJobs)
        .where(eq(standupOutboxJobs.sessionId, session.id))
        .orderBy(asc(standupOutboxJobs.priority), asc(standupOutboxJobs.createdAt), asc(standupOutboxJobs.id)),
      db
        .select()
        .from(standupDeadLetters)
        .where(eq(standupDeadLetters.sessionId, session.id))
        .orderBy(asc(standupDeadLetters.createdAt), asc(standupDeadLetters.id)),
    ]);

    const missingEvidence: string[] = [];
    if (!session.standupIssueId) missingEvidence.push("standup_issue");
    if (participants.length === 0) missingEvidence.push("participants");
    if (policy && participants.length < policy.participantAgentIds.length) missingEvidence.push("all_participants");
    if (participants.some((participant) => !participant.directiveIssueId)) missingEvidence.push("directive_issue");
    if (outboxJobs.length === 0) missingEvidence.push("outbox");
    const deliveredDirectiveParticipantIds = new Set(
      outboxJobs
        .filter((job) =>
          job.jobType === "directive_wakeup" &&
          job.status === "succeeded" &&
          !!job.deliveredAt &&
          !!job.participantId,
        )
        .map((job) => job.participantId!),
    );
    const allDirectivesDelivered =
      participants.length > 0 &&
      participants.every((participant) => participantHasDirectiveDelivery(participant, deliveredDirectiveParticipantIds));
    if (participants.length > 0 && !allDirectivesDelivered) missingEvidence.push("directive_delivery");
    if (actions.length === 0) {
      missingEvidence.push("action");
    } else if (actions.some((action) => !actionHasTimelyProof(action))) {
      missingEvidence.push("action_timing");
    }
    if (actions.some((action) => !actionHasDeliveryReceipt(action, outboxJobs))) {
      missingEvidence.push("action_delivery");
    }
    if (escalations.some((escalation) => !escalation.actingOwnerAgentId)) {
      missingEvidence.push("escalation_acting_owner");
    }
    if (escalations.some((escalation) => !escalation.closureCondition?.trim())) {
      missingEvidence.push("escalation_closure");
    }
    if (escalations.some((escalation) => !escalation.deliveryProofId?.trim())) {
      missingEvidence.push("escalation_delivery");
    }

    const standupForced =
      !!session.standupIssueId &&
      ["forced", "completed"].includes(session.status) &&
      participants.length > 0 &&
      participants.every((participant) => participantHasDirectiveDelivery(participant, deliveredDirectiveParticipantIds));
    const actionTaken = actions.some((action) =>
      !!action.issueId &&
      !!action.ownerAgentId &&
      !!action.proofTarget &&
      !!action.dueAt &&
      actionHasTimelyProof(action) &&
      actionHasDeliveryReceipt(action, outboxJobs),
    );
    const assessment = asRecord(session.assessmentSnapshot);
    const rawStatus =
      typeof assessment.carStatus === "string"
        ? assessment.carStatus
        : typeof assessment.status === "string"
          ? assessment.status
          : null;
    const carStillNonGreen = assessment.nonGreen === true || (rawStatus != null && rawStatus.toLowerCase() !== "green");
    const partialFailure = ["incomplete", "failed"].includes(session.status) || !!session.failureReason || deadLetters.length > 0;

    return {
      policy,
      session,
      participants: participants as Array<typeof standupParticipants.$inferSelect>,
      responses: responses as Array<typeof standupResponses.$inferSelect>,
      actions: actions as Array<typeof standupActions.$inferSelect>,
      escalations: escalations as Array<typeof standupEscalations.$inferSelect>,
      outboxJobs: outboxJobs as Array<typeof standupOutboxJobs.$inferSelect>,
      deadLetters: deadLetters as Array<typeof standupDeadLetters.$inferSelect>,
      standup_forced: standupForced,
      action_taken: actionTaken,
      car_still_non_green: carStillNonGreen,
      partial_failure: partialFailure,
      missing_evidence: missingEvidence,
    };
  }

  return {
    deliverIssueAssignment,

    getPolicy: (companyId: string, policyKey: string, standupType = "daily") =>
      getPolicyByKey(db, companyId, policyKey, standupType),

    getOutboxJob: async (jobId: string) =>
      db
        .select()
        .from(standupOutboxJobs)
        .where(eq(standupOutboxJobs.id, jobId))
        .then((rows) => rows[0] ?? null),

    upsertPolicy: async (companyId: string, input: UpsertStandupPolicy, actor: Actor = {}) => {
      assertTimeZone(input.timezone);
      const cronError = validateCron(input.scheduleCron);
      if (cronError) throw unprocessable(cronError);
      await validateServiceRun(db, companyId, input.serviceRunId);
      await assertCompanyAgents(db, companyId, input.participantAgentIds);
      await assertLinkedRoutine(db, companyId, input.linkedRoutineId);

      const now = new Date();
      const values = {
        companyId,
        policyKey: input.policyKey,
        standupType: input.standupType,
        title: input.title,
        status: input.status ?? "active",
        timezone: input.timezone,
        scheduleCron: input.scheduleCron,
        recoveryByLocalTime: input.recoveryByLocalTime,
        responseDueLocalTime: input.responseDueLocalTime,
        escalationDueLocalTime: input.escalationDueLocalTime,
        participantAgentIds: input.participantAgentIds,
        responseSchema: input.responseSchema,
        genericAnswerDenylist: input.genericAnswerDenylist,
        nonGreenTriggerRule: input.nonGreenTriggerRule,
        actionRouting: input.actionRouting,
        disableSettings: input.disableSettings,
        linkedRoutineId: input.linkedRoutineId ?? null,
        serviceRunId: input.serviceRunId,
        disabledAt: input.status === "disabled" ? now : null,
        updatedAt: now,
      };

      const [policy] = await db
        .insert(standupPolicies)
        .values({
          ...values,
          version: 1,
        })
        .onConflictDoUpdate({
          target: [standupPolicies.companyId, standupPolicies.policyKey],
          set: {
            ...values,
            version: sql`${standupPolicies.version} + 1`,
          },
        })
        .returning();

      void actor;
      return policy;
    },

    disablePolicy: async (companyId: string, input: DisableStandupPolicy) => {
      await validateServiceRun(db, companyId, input.serviceRunId);
      const existing = await getPolicyByKey(db, companyId, input.policyKey, input.standupType);
      if (!existing) throw notFound("Standup policy not found");
      const now = new Date();
      const [policy] = await db
        .update(standupPolicies)
        .set({
          status: "disabled",
          disabledAt: now,
          disableSettings: {
            ...asRecord(existing.disableSettings),
            lastDisableReason: input.reason,
            drainMode: input.drainMode,
          },
          serviceRunId: input.serviceRunId,
          updatedAt: now,
        })
        .where(eq(standupPolicies.id, existing.id))
        .returning();
      return policy;
    },

    fireStandup: async (companyId: string, input: FireStandupInput) => {
      await validateServiceRun(db, companyId, input.serviceRunId);
      const policy = await getPolicyByKey(db, companyId, input.policyKey, input.standupType);
      if (!policy) throw notFound("Standup policy not found");
      if (policy.status !== "active") throw conflict("Standup policy is disabled");
      const participantAgents = await assertCompanyAgents(db, companyId, policy.participantAgentIds);
      const routine = await assertLinkedRoutine(db, companyId, input.routineId ?? policy.linkedRoutineId);
      const localDate = input.localDate ?? localDateFor(new Date(), policy.timezone);
      const responseDueAt = wallTimeToDate(localDate, policy.responseDueLocalTime, policy.timezone);
      const escalationDueAt = wallTimeToDate(localDate, policy.escalationDueLocalTime, policy.timezone);
      const idempotencyKey = input.idempotencyKey ?? `${policy.id}:${localDate}:${policy.standupType}`;
      const now = new Date();

      const sessionId = await db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: standupSessions.id })
          .from(standupSessions)
          .where(
            and(
              eq(standupSessions.companyId, companyId),
              eq(standupSessions.localDate, localDate),
              eq(standupSessions.standupType, policy.standupType),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (existing) return existing.id;

        const standupIssue = await createIssueInTx(tx, companyId, {
          projectId: routine?.projectId ?? null,
          goalId: routine?.goalId ?? null,
          parentId: routine?.parentIssueId ?? null,
          title: `${policy.title} - ${localDate}`,
          description: `Forced ${policy.standupType} standup for ${localDate}. Participants must respond with owner, action, due time, and proof.`,
          status: "todo",
          priority: "high",
          originKind: "standup_session",
          originId: policy.id,
          originRunId: input.routineRunId ?? input.serviceRunId,
        });

        const [session] = await tx
          .insert(standupSessions)
          .values({
            companyId,
            policyId: policy.id,
            routineId: input.routineId ?? policy.linkedRoutineId ?? null,
            triggerId: input.triggerId ?? null,
            routineRunId: input.routineRunId ?? null,
            serviceRunId: input.serviceRunId,
            standupIssueId: standupIssue.id,
            localDate,
            standupType: policy.standupType,
            policyVersion: policy.version,
            timezone: policy.timezone,
            status: "forced",
            triggerSource: input.triggerSource ?? "manual",
            idempotencyKey,
            triggerConditionSnapshot: input.triggerConditionSnapshot,
            assessmentSnapshot: input.assessmentSnapshot,
            manualTriggerReceipt: input.manualTriggerReceipt ?? null,
            partialIssueIds: [standupIssue.id],
            responseDueAt,
            escalationDueAt,
            firedAt: now,
          })
          .returning();

        const issueIds = [standupIssue.id];
        for (const agentId of policy.participantAgentIds) {
          const agent = participantAgents.find((row) => row.id === agentId);
          if (!agent) throw unprocessable("Participant agent not found after validation");
          const directiveIssue = await createIssueInTx(tx, companyId, {
            projectId: routine?.projectId ?? null,
            goalId: routine?.goalId ?? null,
            parentId: standupIssue.id,
            title: `Standup response required: ${agent.name} - ${localDate}`,
            description: directiveBody({ policy, session, agentName: agent.name }),
            status: "todo",
            priority: "high",
            assigneeAgentId: agent.id,
            originKind: "standup_directive",
            originId: session.id,
            originRunId: input.routineRunId ?? input.serviceRunId,
          });
          issueIds.push(directiveIssue.id);
          const [participant] = await tx
            .insert(standupParticipants)
            .values({
              companyId,
              sessionId: session.id,
              agentId: agent.id,
              roleKey: agent.role || agent.name,
              directiveIssueId: directiveIssue.id,
              responseStatus: "pending",
              deliveryStatus: "queued",
              responseDueAt,
              escalationDueAt,
            })
            .returning();
          await tx.insert(standupOutboxJobs).values({
            companyId,
            sessionId: session.id,
            participantId: participant.id,
            serviceRunId: input.serviceRunId,
            jobType: "directive_wakeup",
            priority: 10,
            targetKind: "agent",
            targetId: agent.id,
            idempotencyKey: `${session.id}:directive_wakeup:${agent.id}`,
            payload: {
              directiveIssueId: directiveIssue.id,
              responseDueAt: responseDueAt.toISOString(),
              escalationDueAt: escalationDueAt.toISOString(),
            },
          });
        }

        await tx
          .update(standupSessions)
          .set({ partialIssueIds: issueIds, updatedAt: now })
          .where(eq(standupSessions.id, session.id));
        return session.id;
      }).catch(async (error) => {
        const existing = await db
          .select({ id: standupSessions.id })
          .from(standupSessions)
          .where(
            and(
              eq(standupSessions.companyId, companyId),
              eq(standupSessions.localDate, localDate),
              eq(standupSessions.standupType, policy.standupType),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (existing) return existing.id;
        if (isUniqueConstraint(error, "standup_sessions_company_date_type_uq")) throw error;

        const [failed] = await db
          .insert(standupSessions)
          .values({
            companyId,
            policyId: policy.id,
            routineId: input.routineId ?? policy.linkedRoutineId ?? null,
            triggerId: input.triggerId ?? null,
            routineRunId: input.routineRunId ?? null,
            serviceRunId: input.serviceRunId,
            standupIssueId: null,
            localDate,
            standupType: policy.standupType,
            policyVersion: policy.version,
            timezone: policy.timezone,
            status: "failed",
            triggerSource: input.triggerSource ?? "manual",
            idempotencyKey,
            triggerConditionSnapshot: input.triggerConditionSnapshot,
            assessmentSnapshot: input.assessmentSnapshot,
            manualTriggerReceipt: input.manualTriggerReceipt ?? null,
            partialIssueIds: [],
            responseDueAt,
            escalationDueAt,
            firedAt: now,
            failureReason: errorMessage(error),
          })
          .returning({ id: standupSessions.id });
        return failed.id;
      });

      return inspect({ sessionId });
    },

    submitResponse: async (input: SubmitStandupResponse, actor: { agentId: string }) => {
      const participant = await db
        .select()
        .from(standupParticipants)
        .where(eq(standupParticipants.id, input.participantId))
        .then((rows) => rows[0] ?? null);
      if (!participant) throw notFound("Standup participant not found");
      if (participant.sessionId !== input.sessionId) throw forbidden("Participant does not belong to session");
      if (participant.agentId !== actor.agentId) throw forbidden("Standup response actor must match participant agent");
      await validateServiceRun(db, participant.companyId, input.actorRunId, actor.agentId);

      const session = await db
        .select()
        .from(standupSessions)
        .where(eq(standupSessions.id, participant.sessionId))
        .then((rows) => rows[0] ?? null);
      if (!session) throw notFound("Standup session not found");
      const policy = await db
        .select()
        .from(standupPolicies)
        .where(eq(standupPolicies.id, session.policyId))
        .then((rows) => rows[0] ?? null);
      if (!policy) throw notFound("Standup policy not found");

      const responseSchemaReason = responseSchemaRejectedReason(input.response, policy.responseSchema);
      const responseJson = responseJsonForStorage(input.response);
      const generic = !responseSchemaReason && responseHasGenericAnswer(input.response, policy.genericAnswerDenylist);
      const rejectedReason = responseSchemaReason ?? (generic ? "generic_answer_denylist" : null);
      const now = new Date();
      const existingAccepted = await db
        .select()
        .from(standupResponses)
        .where(and(eq(standupResponses.participantId, participant.id), eq(standupResponses.valid, true)))
        .then((rows) => rows[0] ?? null);

      const responseValues = {
          companyId: participant.companyId,
          sessionId: session.id,
          participantId: participant.id,
          actorAgentId: actor.agentId,
          actorRunId: input.actorRunId,
          responseJson,
          valid: !rejectedReason,
          rejectedReason,
          submittedAt: now,
      };
      const [response] = existingAccepted && !rejectedReason
        ? await db
          .update(standupResponses)
          .set({
            responseJson,
            actorRunId: input.actorRunId,
            submittedAt: now,
            updatedAt: now,
          })
          .where(eq(standupResponses.id, existingAccepted.id))
          .returning()
        : await db
          .insert(standupResponses)
          .values(responseValues)
          .returning();

      await db
        .update(standupParticipants)
        .set({
          responseStatus: rejectedReason ? "rejected" : "accepted",
          respondedAt: now,
          updatedAt: now,
        })
        .where(eq(standupParticipants.id, participant.id));

      return response;
    },

    createAction: async (input: CreateStandupAction) => {
      const session = await db
        .select()
        .from(standupSessions)
        .where(eq(standupSessions.id, input.sessionId))
        .then((rows) => rows[0] ?? null);
      if (!session) throw notFound("Standup session not found");
      await validateServiceRun(db, session.companyId, input.serviceRunId);
      await assertCompanyAgents(db, session.companyId, [input.ownerAgentId]);
      const now = new Date();

      const selectExistingAction = (dbOrTx: DbOrTx) => dbOrTx
        .select()
        .from(standupActions)
        .where(and(eq(standupActions.companyId, session.companyId), eq(standupActions.canonicalKey, input.canonicalKey)))
        .then((rows: Array<typeof standupActions.$inferSelect>) => rows[0] ?? null);

      const createActionInTransaction = () => db.transaction(async (tx) => {
        const existing = await selectExistingAction(tx);
        if (existing) return existing;

        const issue = await createIssueInTx(tx, session.companyId, {
          title: `Standup action: ${input.sourceBlockerKey}`,
          description: actionBody(input),
          status: "todo",
          priority: "high",
          assigneeAgentId: input.ownerAgentId,
          originKind: "standup_action",
          originId: session.id,
          originRunId: input.serviceRunId,
        });
        const [action] = await tx
          .insert(standupActions)
          .values({
            companyId: session.companyId,
            sessionId: session.id,
            ownerAgentId: input.ownerAgentId,
            issueId: issue.id,
            serviceRunId: input.serviceRunId,
            canonicalKey: input.canonicalKey,
            sourceBlockerKey: input.sourceBlockerKey,
            dueAt: new Date(input.dueAt),
            proofTarget: input.proofTarget,
            timingState: input.timingState,
            status: input.status ?? "open",
            actionJson: input.actionJson ?? {},
          })
          .returning();
        await tx
          .insert(standupOutboxJobs)
          .values({
            companyId: session.companyId,
            sessionId: session.id,
            actionId: action.id,
            serviceRunId: input.serviceRunId,
            jobType: "action_wakeup",
            priority: 20,
            targetKind: "agent",
            targetId: input.ownerAgentId,
            idempotencyKey: `${session.id}:action_wakeup:${input.canonicalKey}`,
            payload: {
              issueId: issue.id,
              dueAt: input.dueAt,
              proofTarget: input.proofTarget,
            },
            nextAttemptAt: now,
          })
          .onConflictDoNothing();
        return action;
      });

      try {
        return await createActionInTransaction();
      } catch (error) {
        if (!isUniqueConstraint(error, "standup_actions_company_canonical_key_uq")) throw error;
        const existing = await selectExistingAction(db);
        if (!existing) throw error;
        return existing;
      }
    },

    evaluateSla: async (input: EvaluateStandupSla) => {
      const session = await db
        .select()
        .from(standupSessions)
        .where(eq(standupSessions.id, input.sessionId))
        .then((rows) => rows[0] ?? null);
      if (!session) throw notFound("Standup session not found");
      await validateServiceRun(db, session.companyId, input.serviceRunId);
      const policy = await db
        .select()
        .from(standupPolicies)
        .where(eq(standupPolicies.id, session.policyId))
        .then((rows) => rows[0] ?? null);
      if (!policy) throw notFound("Standup policy not found");
      const now = input.now ? new Date(input.now) : new Date();
      const staleParticipants = await db
        .select()
        .from(standupParticipants)
        .where(
          and(
            eq(standupParticipants.sessionId, session.id),
            inArray(standupParticipants.responseStatus, ["pending", "rejected", "missing"]),
            lte(standupParticipants.responseDueAt, now),
          ),
        )
        .orderBy(asc(standupParticipants.createdAt), asc(standupParticipants.id));

      for (const participant of staleParticipants) {
        const actingOwnerAgentId = resolveActingOwnerAgentId(policy, participant);
        await assertCompanyAgents(db, session.companyId, [actingOwnerAgentId]);
        const canonicalKey = `${session.id}:missing_response:${participant.agentId}`;
        const reason = participant.responseStatus === "rejected" ? "invalid_or_generic_response" : "missing_response";
        const closureCondition = "Participant submits a valid standup response or the acting owner records explicit recovery action.";

        const selectExistingEscalation = (dbOrTx: DbOrTx) => dbOrTx
          .select()
          .from(standupEscalations)
          .where(and(eq(standupEscalations.companyId, session.companyId), eq(standupEscalations.canonicalKey, canonicalKey)))
          .then((rows: Array<typeof standupEscalations.$inferSelect>) => rows[0] ?? null);

        const writeEscalation = async (
          tx: DbOrTx,
          existing: typeof standupEscalations.$inferSelect | null,
        ) => {
          const escalationIssue = existing?.escalationIssueId
            ? null
            : await createIssueInTx(tx, session.companyId, {
              title: `Standup escalation: ${participant.agentId}`,
              description: escalationBody({ policy, participant, reason, deadlineAt: participant.escalationDueAt, closureCondition }),
              status: "todo",
              priority: "high",
              assigneeAgentId: actingOwnerAgentId,
              originKind: "standup_escalation",
              originId: session.id,
              originRunId: input.serviceRunId,
            });
          const [escalation] = existing
            ? await tx
              .update(standupEscalations)
              .set({
                reason,
                actingOwnerAgentId,
                deadlineAt: participant.escalationDueAt,
                closureCondition,
                serviceRunId: input.serviceRunId,
                updatedAt: now,
              })
              .where(eq(standupEscalations.id, existing.id))
              .returning()
            : await tx
              .insert(standupEscalations)
              .values({
                companyId: session.companyId,
                sessionId: session.id,
                participantId: participant.id,
                agentId: participant.agentId,
                actingOwnerAgentId,
                escalationIssueId: escalationIssue?.id ?? null,
                serviceRunId: input.serviceRunId,
                canonicalKey,
                reason,
                deadlineAt: participant.escalationDueAt,
                closureCondition,
                status: "acting_owner_assigned",
              })
              .returning();

          await tx
            .update(standupParticipants)
            .set({
              responseStatus: "escalated",
              escalatedAt: now,
              escalationId: escalation.id,
              updatedAt: now,
            })
            .where(eq(standupParticipants.id, participant.id));
          const [queuedEscalationJob] = await tx
            .insert(standupOutboxJobs)
            .values({
              companyId: session.companyId,
              sessionId: session.id,
              participantId: participant.id,
              escalationId: escalation.id,
              serviceRunId: input.serviceRunId,
              jobType: "escalation_wakeup",
              priority: 5,
              targetKind: "agent",
              targetId: actingOwnerAgentId,
              idempotencyKey: `${session.id}:escalation_wakeup:${participant.agentId}`,
              payload: {
                escalationIssueId: escalation.escalationIssueId ?? escalationIssue?.id ?? null,
                reason,
                deadlineAt: participant.escalationDueAt.toISOString(),
              },
              nextAttemptAt: now,
            })
            .onConflictDoNothing()
            .returning();
          const escalationJob = queuedEscalationJob ?? await tx
            .select()
            .from(standupOutboxJobs)
            .where(and(eq(standupOutboxJobs.companyId, session.companyId), eq(standupOutboxJobs.idempotencyKey, `${session.id}:escalation_wakeup:${participant.agentId}`)))
            .then((rows: Array<typeof standupOutboxJobs.$inferSelect>) => rows[0] ?? null);
          if (!escalationJob) return escalation;
          const [updatedEscalation] = await tx
            .update(standupEscalations)
            .set({
              deliveryProofId: `outbox:${escalationJob.id}:queued`,
              updatedAt: now,
            })
            .where(eq(standupEscalations.id, escalation.id))
            .returning();
          return updatedEscalation;
        };

        try {
          await db.transaction(async (tx) => {
            const existing = await selectExistingEscalation(tx);
            await writeEscalation(tx, existing);
          });
        } catch (error) {
          if (!isUniqueConstraint(error, "standup_escalations_company_canonical_key_uq")) throw error;
          await db.transaction(async (tx) => {
            const existing = await selectExistingEscalation(tx);
            if (!existing) throw error;
            await writeEscalation(tx, existing);
          });
        }
      }

      return inspect({ sessionId: session.id });
    },

    processOutbox: async (input: OutboxProcessInput = {}) => {
      const now = input.now ?? new Date();
      const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
      if (input.companyId && input.serviceRunId) {
        await validateServiceRun(db, input.companyId, input.serviceRunId);
      }
      const predicates = [
        inArray(standupOutboxJobs.status, ["queued", "failed"]),
        lte(standupOutboxJobs.nextAttemptAt, now),
        isNull(standupOutboxJobs.deadLetteredAt),
      ];
      if (input.companyId) predicates.push(eq(standupOutboxJobs.companyId, input.companyId));
      if (input.sessionId) predicates.push(eq(standupOutboxJobs.sessionId, input.sessionId));
      const jobs = await db
        .select()
        .from(standupOutboxJobs)
        .where(and(...predicates))
        .orderBy(asc(standupOutboxJobs.priority), asc(standupOutboxJobs.createdAt), asc(standupOutboxJobs.id))
        .limit(limit);
      const processed: Array<typeof standupOutboxJobs.$inferSelect> = [];
      for (const job of jobs) {
        const attempts = job.attempts + 1;
        const delivery: OutboxDeliveryResult = input.deliver
          ? await input.deliver(job)
          : {
            ok: false,
            error: "delivery_adapter_missing",
            retryAt: nextRetryAt(now, attempts),
          };
        const failedPermanently = !delivery.ok && attempts >= job.maxAttempts;
        const proofId = delivery.ok ? deliveryProofId(job, attempts, delivery.proofId) : null;
        const [updated] = await db
          .update(standupOutboxJobs)
          .set({
            status: delivery.ok ? "succeeded" : failedPermanently ? "dead_lettered" : "failed",
            attempts,
            lastAttemptAt: now,
            deliveredAt: delivery.ok ? now : null,
            deadLetteredAt: failedPermanently ? now : null,
            lastError: delivery.ok ? null : delivery.error ?? "delivery_failed",
            nextAttemptAt: delivery.ok ? job.nextAttemptAt : delivery.retryAt ?? nextRetryAt(now, attempts),
            payload: delivery.ok
              ? {
                ...asRecord(job.payload),
                deliveryProofId: proofId,
                deliveredAt: now.toISOString(),
              }
              : job.payload,
            updatedAt: now,
          })
          .where(eq(standupOutboxJobs.id, job.id))
          .returning();
        if (updated.status === "dead_lettered") {
          await db
            .insert(standupDeadLetters)
            .values({
              companyId: updated.companyId,
              sessionId: updated.sessionId,
              outboxJobId: updated.id,
              reason: "max_attempts_exceeded",
              lastError: updated.lastError,
              payloadSnapshot: updated.payload,
            })
            .onConflictDoNothing();
        }
        if (updated.participantId && updated.jobType === "directive_wakeup" && updated.status === "succeeded") {
          await db
            .update(standupParticipants)
            .set({ deliveryStatus: "delivered", updatedAt: now })
            .where(eq(standupParticipants.id, updated.participantId));
        }
        if (updated.escalationId && updated.jobType === "escalation_wakeup" && updated.status === "succeeded") {
          await db
            .update(standupEscalations)
            .set({ deliveryProofId: proofId, updatedAt: now })
            .where(eq(standupEscalations.id, updated.escalationId));
        }
        processed.push(updated);
      }
      return processed;
    },

    replayOutboxJob: async (input: ReplayStandupOutboxJob) => {
      const job = await db
        .select()
        .from(standupOutboxJobs)
        .where(eq(standupOutboxJobs.id, input.jobId))
        .then((rows) => rows[0] ?? null);
      if (!job) throw notFound("Standup outbox job not found");
      await validateServiceRun(db, job.companyId, input.serviceRunId);
      if (input.jobType && job.jobType !== input.jobType) throw unprocessable("Outbox job type mismatch");
      const existingReplay = await db
        .select()
        .from(standupOutboxJobs)
        .where(and(eq(standupOutboxJobs.companyId, job.companyId), eq(standupOutboxJobs.idempotencyKey, input.idempotencyKey)))
        .then((rows) => rows[0] ?? null);
      if (existingReplay) {
        if (existingReplay.replayOfJobId !== job.id) {
          throw conflict("Replay idempotency key belongs to another outbox job");
        }
        return existingReplay;
      }
      const [replay] = await db
        .insert(standupOutboxJobs)
        .values({
          companyId: job.companyId,
          sessionId: job.sessionId,
          participantId: job.participantId,
          actionId: job.actionId,
          escalationId: job.escalationId,
          serviceRunId: input.serviceRunId,
          jobType: job.jobType,
          priority: Math.max(1, job.priority - 1),
          targetKind: job.targetKind,
          targetId: job.targetId,
          idempotencyKey: input.idempotencyKey,
          payload: {
            ...job.payload,
            replayOfJobId: job.id,
          },
          replayOfJobId: job.id,
        })
        .returning();
      await db
        .update(standupDeadLetters)
        .set({
          replayReceipt: {
            replayJobId: replay.id,
            serviceRunId: input.serviceRunId,
          },
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(standupDeadLetters.outboxJobId, job.id));
      return replay;
    },

    inspect,
  };
}
