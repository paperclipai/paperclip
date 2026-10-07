import { issueExecutionMonitorPolicySchema } from "@paperclipai/shared";
import type { issues } from "@paperclipai/db";
import { z } from "zod";
import { forbidden, unprocessable } from "../errors.js";
import type { accessService } from "./access.js";
import { authorizationDeniedDetails, type AuthorizationActor } from "./authorization.js";
import { applyIssueMonitorPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState, redactIssueMonitorExternalRef, setIssueExecutionPolicyMonitorScheduledBy } from "./issue-execution-policy.js";

type NormalizedExecutionPolicy = ReturnType<typeof normalizeIssueExecutionPolicy>;

export function monitorPoliciesEqual(
  left: NormalizedExecutionPolicy | null,
  right: NormalizedExecutionPolicy | null,
) {
  return (
    JSON.stringify(left?.monitor ?? null) ===
    JSON.stringify(right?.monitor ?? null)
  );
}

export function applyActorMonitorScheduledBy(
  policy: NormalizedExecutionPolicy | null,
  actorType: "agent" | "user",
) {
  return setIssueExecutionPolicyMonitorScheduledBy(
    policy,
    actorType === "user" ? "board" : "assignee",
  );
}

export async function assertCanManageIssueMonitor(
  accessSvc: Pick<ReturnType<typeof accessService>, "decide">,
  req: { actor: AuthorizationActor },
  companyId: string,
  assigneeAgentId: string | null,
  monitorChanged: boolean,
) {
  if (!monitorChanged) return;
  if (req.actor.type === "board") return;
  const runtimeDecision = await accessSvc.decide({
    actor: req.actor,
    action: "runtime:manage",
    resource: { type: "company", companyId },
  });
  if (!runtimeDecision.allowed) {
    throw forbidden(
      runtimeDecision.explanation,
      authorizationDeniedDetails(runtimeDecision),
    );
  }
  if (
    req.actor.type === "agent" &&
    req.actor.agentId &&
    req.actor.agentId === assigneeAgentId
  )
    return;
  throw forbidden(
    "Only the assignee agent or a board user can manage issue monitors",
  );
}

export function summarizeIssueMonitor(
  issue: {
    monitorNextCheckAt?: Date | null;
    monitorLastTriggeredAt?: Date | null;
    monitorAttemptCount?: number | null;
    monitorNotes?: string | null;
    monitorScheduledBy?: string | null;
    executionState?: unknown;
  },
  policy: NormalizedExecutionPolicy | null,
) {
  const state = parseIssueExecutionState(issue.executionState);
  return {
    nextCheckAt:
      issue.monitorNextCheckAt?.toISOString() ??
      policy?.monitor?.nextCheckAt ??
      null,
    lastTriggeredAt:
      issue.monitorLastTriggeredAt?.toISOString() ??
      state?.monitor?.lastTriggeredAt ??
      null,
    attemptCount:
      issue.monitorAttemptCount ?? state?.monitor?.attemptCount ?? 0,
    notes:
      policy?.monitor?.notes ??
      issue.monitorNotes ??
      state?.monitor?.notes ??
      null,
    scheduledBy:
      issue.monitorScheduledBy ??
      policy?.monitor?.scheduledBy ??
      state?.monitor?.scheduledBy ??
      null,
    kind: policy?.monitor?.kind ?? state?.monitor?.kind ?? null,
    serviceName:
      policy?.monitor?.serviceName ?? state?.monitor?.serviceName ?? null,
    externalRef: redactIssueMonitorExternalRef(
      policy?.monitor?.externalRef ?? state?.monitor?.externalRef ?? null,
    ),
    timeoutAt: policy?.monitor?.timeoutAt ?? state?.monitor?.timeoutAt ?? null,
    maxAttempts:
      policy?.monitor?.maxAttempts ?? state?.monitor?.maxAttempts ?? null,
    recoveryPolicy:
      policy?.monitor?.recoveryPolicy ?? state?.monitor?.recoveryPolicy ?? null,
    status: state?.monitor?.status ?? (policy?.monitor ? "scheduled" : null),
    clearReason: state?.monitor?.clearReason ?? null,
  };
}

export const setTaskMonitorSchema = z.object({
  taskId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(1).max(240),
  monitor: issueExecutionMonitorPolicySchema.omit({ scheduledBy: true }).extend({
    notes: z.string().trim().min(1).max(500),
  }).strict().nullable(),
}).strict();

/** Caller holds the issue lock; merge only monitor state, never review policy. */
export function prepareIssueMonitorUpdate(
  issue: typeof issues.$inferSelect,
  monitor: z.infer<typeof setTaskMonitorSchema>["monitor"],
  actor: AuthorizationActor,
  now = new Date(),
) {
  if (monitor && Date.parse(monitor.nextCheckAt) <= now.getTime()) {
    throw unprocessable("Monitor nextCheckAt must be in the future");
  }
  if (monitor?.timeoutAt && Date.parse(monitor.timeoutAt) <= Date.parse(monitor.nextCheckAt)) {
    throw unprocessable("Monitor timeoutAt must be later than nextCheckAt");
  }
  const previousPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy);
  const policy = applyActorMonitorScheduledBy(normalizeIssueExecutionPolicy({
    ...previousPolicy, monitor,
  }), actor.type === "board" ? "user" : "agent");
  const transition = applyIssueMonitorPolicyTransition({
    issue, policy, previousPolicy, requestedAssigneePatch: {},
    actor: { agentId: actor.agentId ?? null, userId: actor.userId ?? null },
    monitorExplicitlyUpdated: true,
  });
  // Normalization supplies monitor defaults, but must not rewrite unrelated
  // review/authorization settings (including forward-compatible policy fields).
  const storedPolicy = { ...(issue.executionPolicy ?? {}) };
  if (policy?.monitor) storedPolicy.monitor = policy.monitor;
  else delete storedPolicy.monitor;
  return { ...transition.patch, executionPolicy: Object.keys(storedPolicy).length ? storedPolicy : null } as Partial<typeof issues.$inferInsert>;
}

/** Timestamp presence alone is not authority to park a native task. */
export function eligibleIssueMonitorWait(
  issue: typeof issues.$inferSelect,
  agentId: string,
  now = new Date(),
): string | null {
  if (issue.assigneeAgentId !== agentId || issue.assigneeUserId ||
      !["in_progress", "in_review"].includes(issue.status) || !issue.monitorNextCheckAt) return null;
  const monitor = normalizeIssueExecutionPolicy(issue.executionPolicy)?.monitor;
  if (!monitor || Date.parse(monitor.nextCheckAt) !== issue.monitorNextCheckAt.getTime() ||
      (monitor.timeoutAt && Date.parse(monitor.timeoutAt) <= now.getTime()) ||
      (monitor.maxAttempts != null && issue.monitorAttemptCount >= monitor.maxAttempts)) return null;
  return issue.monitorNextCheckAt.toISOString();
}
