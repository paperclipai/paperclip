import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueWatchdogs, routines, statusCards } from "@paperclipai/db";
import { unprocessable } from "../errors.js";

export const BOARD_UI_CREATE_ONLY_ASSIGNMENT_MODE = "board_ui_create_only" as const;
export const RESERVED_AGENT_BOARD_UI_ONLY_CODE = "reserved_agent_board_ui_only" as const;
export const RESERVED_AGENT_AUTOMATIC_CONFIGURATION_CODE =
  "reserved_agent_automatic_configuration" as const;

export type IssueAssignmentAdmission = {
  surface: "board_ui_issue_create" | "board_ui_issue_update";
  actorType: "user" | "agent" | "system";
  actorSource:
    | "local_implicit"
    | "session"
    | "board_key"
    | "agent_key"
    | "agent_jwt"
    | "cloud_tenant"
    | "system";
  actorUserId: string | null;
};

export type BoardUiCreateOnlyAssignmentPolicy = {
  mode: typeof BOARD_UI_CREATE_ONLY_ASSIGNMENT_MODE;
  allowedUserIds: string[];
  valid: boolean;
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBoardUiCreateOnlyAssignmentPolicy(
  authorizationPolicy: unknown,
): BoardUiCreateOnlyAssignmentPolicy | null {
  if (!isPlainRecord(authorizationPolicy)) return null;
  const assignmentPolicy = authorizationPolicy.assignmentPolicy;
  if (!isPlainRecord(assignmentPolicy)) return null;
  if (assignmentPolicy.mode !== BOARD_UI_CREATE_ONLY_ASSIGNMENT_MODE) return null;

  const rawAllowedUserIds = assignmentPolicy.allowedUserIds;
  const allowedUserIds = Array.isArray(rawAllowedUserIds)
    ? Array.from(new Set(
      rawAllowedUserIds
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    ))
    : [];
  const valid = Array.isArray(rawAllowedUserIds) &&
    rawAllowedUserIds.length > 0 &&
    rawAllowedUserIds.every((value) => typeof value === "string" && value.trim().length > 0) &&
    allowedUserIds.length > 0;

  return {
    mode: BOARD_UI_CREATE_ONLY_ASSIGNMENT_MODE,
    allowedUserIds,
    valid,
  };
}

export function readAgentBoardUiCreateOnlyAssignmentPolicy(
  agent: { permissions?: unknown } | null | undefined,
) {
  if (!agent || !isPlainRecord(agent.permissions)) return null;
  return readBoardUiCreateOnlyAssignmentPolicy(agent.permissions.authorizationPolicy);
}

export function isAgentEligibleForAutomaticAssignment(
  agent: { permissions?: unknown } | null | undefined,
) {
  return readAgentBoardUiCreateOnlyAssignmentPolicy(agent) === null;
}

export async function assertAgentEligibleForAutomaticAssignment(
  db: Db,
  companyId: string,
  agentId: string,
  automationKind: "routine" | "task_watchdog" | "status_card",
) {
  const agent = await db
    .select({ companyId: agents.companyId, permissions: agents.permissions })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);
  if (!agent || agent.companyId !== companyId) return;
  if (!readAgentBoardUiCreateOnlyAssignmentPolicy(agent)) return;
  throw unprocessable("This reserved agent cannot be configured as an automatic work owner.", {
    code: RESERVED_AGENT_AUTOMATIC_CONFIGURATION_CODE,
    agentId,
    automationKind,
  });
}

export async function assertBoardUiCreateOnlyActivationHasNoAutomaticReferences(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    nextPermissions: unknown;
  },
) {
  if (!readAgentBoardUiCreateOnlyAssignmentPolicy({ permissions: input.nextPermissions })) return;
  const [routine, watchdog, statusCard] = await Promise.all([
    db
      .select({ id: routines.id })
      .from(routines)
      .where(and(
        eq(routines.companyId, input.companyId),
        eq(routines.assigneeAgentId, input.agentId),
        eq(routines.status, "active"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: issueWatchdogs.id })
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, input.companyId),
        eq(issueWatchdogs.watchdogAgentId, input.agentId),
        eq(issueWatchdogs.status, "active"),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select({ id: statusCards.id })
      .from(statusCards)
      .where(and(
        eq(statusCards.companyId, input.companyId),
        eq(statusCards.agentId, input.agentId),
        isNull(statusCards.archivedAt),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  const references = [
    ...(routine ? [{ kind: "routine", id: routine.id }] : []),
    ...(watchdog ? [{ kind: "task_watchdog", id: watchdog.id }] : []),
    ...(statusCard ? [{ kind: "status_card", id: statusCard.id }] : []),
  ];
  if (references.length === 0) return;
  throw unprocessable(
    "Remove this agent from active automatic configurations before reserving it for board-created tasks.",
    {
      code: RESERVED_AGENT_AUTOMATIC_CONFIGURATION_CODE,
      agentId: input.agentId,
      references,
    },
  );
}

export function boardUiCreateOnlyIssueExecutionAllowed(input: {
  policy: BoardUiCreateOnlyAssignmentPolicy;
  agentId: string;
  issue: {
    assigneeAgentId: string | null | undefined;
    originKind: string | null | undefined;
    createdByAgentId: string | null | undefined;
    createdByUserId: string | null | undefined;
  } | null | undefined;
}) {
  const { policy, agentId, issue } = input;
  return Boolean(
    policy.valid &&
    issue &&
    issue.assigneeAgentId === agentId &&
    issue.originKind === "manual" &&
    !issue.createdByAgentId &&
    issue.createdByUserId &&
    policy.allowedUserIds.includes(issue.createdByUserId),
  );
}

function isAllowedBoardSession(
  admission: IssueAssignmentAdmission | null | undefined,
  policy: BoardUiCreateOnlyAssignmentPolicy,
) {
  return Boolean(
    policy.valid &&
    admission?.actorType === "user" &&
    admission.actorSource === "session" &&
    admission.actorUserId &&
    policy.allowedUserIds.includes(admission.actorUserId),
  );
}

export function boardUiCreateOnlyIssueAssignmentAllowed(input: {
  policy: BoardUiCreateOnlyAssignmentPolicy;
  mutation: "create" | "update";
  admission?: IssueAssignmentAdmission | null;
  issue: {
    originKind: string | null | undefined;
    createdByAgentId: string | null | undefined;
    createdByUserId: string | null | undefined;
  };
}) {
  const { policy, admission, issue } = input;
  if (!isAllowedBoardSession(admission, policy)) return false;
  if (
    admission?.surface !==
      (input.mutation === "create" ? "board_ui_issue_create" : "board_ui_issue_update")
  ) return false;
  if ((issue.originKind ?? "manual") !== "manual") return false;
  if (issue.createdByAgentId) return false;
  if (!issue.createdByUserId || issue.createdByUserId !== admission.actorUserId) return false;
  return policy.allowedUserIds.includes(issue.createdByUserId);
}

export async function assertAgentAssignmentAllowedForIssueMutation(
  db: Db,
  input: {
    companyId: string;
    assigneeAgentId: string;
    mutation: "create" | "update";
    admission?: IssueAssignmentAdmission | null;
    issue: {
      originKind: string | null | undefined;
      createdByAgentId: string | null | undefined;
      createdByUserId: string | null | undefined;
    };
  },
) {
  const target = await db
    .select({ id: agents.id, companyId: agents.companyId, permissions: agents.permissions })
    .from(agents)
    .where(eq(agents.id, input.assigneeAgentId))
    .then((rows) => rows[0] ?? null);
  const policy = readAgentBoardUiCreateOnlyAssignmentPolicy(target);
  if (!policy) return;
  if (
    target?.companyId === input.companyId &&
    boardUiCreateOnlyIssueAssignmentAllowed({
      policy,
      mutation: input.mutation,
      admission: input.admission,
      issue: input.issue,
    })
  ) return;

  throw unprocessable(
    "This reserved agent can only receive manual issues created or reassigned in the board UI by an allowed user.",
    {
      code: RESERVED_AGENT_BOARD_UI_ONLY_CODE,
      assigneeAgentId: input.assigneeAgentId,
      assignmentPolicyMode: BOARD_UI_CREATE_ONLY_ASSIGNMENT_MODE,
    },
  );
}
