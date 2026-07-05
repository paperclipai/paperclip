import { isDeepStrictEqual } from "node:util";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import { trackInteractionResolved } from "@paperclipai/shared/telemetry";
import type {
  AcceptIssueThreadInteraction,
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  CancelIssueThreadInteraction,
  CreateIssueThreadInteraction,
  IssueThreadInteraction,
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  RequestConfirmationTarget,
  RejectIssueThreadInteraction,
  RespondIssueThreadInteraction,
  SuggestTasksInteraction,
  SuggestTasksResultCreatedTask,
} from "@paperclipai/shared";
import {
  acceptIssueThreadInteractionSchema,
  askUserQuestionsPayloadSchema,
  askUserQuestionsResultSchema,
  cancelIssueThreadInteractionSchema,
  createIssueThreadInteractionSchema,
  rejectIssueThreadInteractionSchema,
  requestCheckboxConfirmationPayloadSchema,
  requestCheckboxConfirmationResultSchema,
  requestConfirmationPayloadSchema,
  requestConfirmationResultSchema,
  suggestTasksPayloadSchema,
  suggestTasksResultSchema,
} from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { getTelemetryClient } from "../telemetry.js";
import { issueService, runWorkspaceIsFinalized } from "./issues.js";

type InteractionActor = {
  agentId?: string | null;
  userId?: string | null;
};

const ISSUE_THREAD_INTERACTION_IDEMPOTENCY_CONSTRAINT =
  "issue_thread_interactions_company_issue_idempotency_uq";

type IssueWakeTarget = {
  id: string;
  assigneeAgentId: string | null;
  assigneeUserId?: string | null;
  status: string;
};

type ResolvedInteractionResult = {
  interaction: IssueThreadInteraction;
  createdIssues: IssueWakeTarget[];
  continuationIssue?: IssueWakeTarget | null;
};

type IssueThreadInteractionRow = typeof issueThreadInteractions.$inferSelect;
type IssueTouchDb = Pick<Db, "update">;

type IssueResolutionContext = {
  id: string;
  companyId: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
};

const REQUEST_CONFIRMATION_INTERACTION_KINDS = [
  "request_confirmation",
  "request_checkbox_confirmation",
] as const;
type RequestConfirmationLikeKind = (typeof REQUEST_CONFIRMATION_INTERACTION_KINDS)[number];
type RequestConfirmationLikeInteraction =
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction;

const USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS = [
  ...REQUEST_CONFIRMATION_INTERACTION_KINDS,
  "ask_user_questions",
] as const;
type UserCommentSupersedableKind = (typeof USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS)[number];
type UserCommentSupersedableInteraction =
  | RequestConfirmationLikeInteraction
  | AskUserQuestionsInteraction;

function isRequestConfirmationLikeKind(kind: string): kind is RequestConfirmationLikeKind {
  return (REQUEST_CONFIRMATION_INTERACTION_KINDS as readonly string[]).includes(kind);
}

function isUserCommentSupersedableKind(kind: string): kind is UserCommentSupersedableKind {
  return (USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS as readonly string[]).includes(kind);
}

function isIssueThreadInteractionIdempotencyConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string; constraint_name?: string };
  const constraint = err.constraint ?? err.constraint_name;
  return err.code === "23505" && constraint === ISSUE_THREAD_INTERACTION_IDEMPOTENCY_CONSTRAINT;
}

function isEquivalentCreateRequest(
  row: IssueThreadInteractionRow,
  input: CreateIssueThreadInteraction,
  actor: InteractionActor,
) {
  return (
    row.kind === input.kind
    && row.continuationPolicy === input.continuationPolicy
    && (row.idempotencyKey ?? null) === (input.idempotencyKey ?? null)
    && (row.sourceCommentId ?? null) === (input.sourceCommentId ?? null)
    && (row.sourceRunId ?? null) === (input.sourceRunId ?? null)
    && (row.title ?? null) === (input.title ?? null)
    && (row.summary ?? null) === (input.summary ?? null)
    && (row.createdByAgentId ?? null) === (actor.agentId ?? null)
    && (row.createdByUserId ?? null) === (actor.userId ?? null)
    && isDeepStrictEqual(row.payload, input.payload)
  );
}

function hydrateInteraction(
  row: IssueThreadInteractionRow,
): IssueThreadInteraction {
  const base = {
    ...row,
    idempotencyKey: row.idempotencyKey ?? null,
    status: row.status as IssueThreadInteraction["status"],
    continuationPolicy: row.continuationPolicy as IssueThreadInteraction["continuationPolicy"],
  };

  switch (row.kind) {
    case "suggest_tasks":
      return {
        ...base,
        kind: "suggest_tasks",
        payload: suggestTasksPayloadSchema.parse(row.payload),
        result: row.result ? suggestTasksResultSchema.parse(row.result) : null,
      } satisfies SuggestTasksInteraction;
    case "ask_user_questions":
      return {
        ...base,
        kind: "ask_user_questions",
        payload: askUserQuestionsPayloadSchema.parse(row.payload),
        result: row.result ? askUserQuestionsResultSchema.parse(row.result) : null,
      } satisfies AskUserQuestionsInteraction;
    case "request_confirmation":
      return {
        ...base,
        kind: "request_confirmation",
        payload: requestConfirmationPayloadSchema.parse(row.payload),
        result: row.result ? requestConfirmationResultSchema.parse(row.result) : null,
      } satisfies RequestConfirmationInteraction;
    case "request_checkbox_confirmation":
      return {
        ...base,
        kind: "request_checkbox_confirmation",
        payload: requestCheckboxConfirmationPayloadSchema.parse(row.payload),
        result: row.result ? requestCheckboxConfirmationResultSchema.parse(row.result) : null,
      } satisfies RequestCheckboxConfirmationInteraction;
    default:
      throw unprocessable(`Unknown interaction kind: ${row.kind}`);
  }
}

async function touchIssue(db: IssueTouchDb, issueId: string) {
  await db
    .update(issues)
    .set({ updatedAt: new Date() })
    .where(eq(issues.id, issueId));
}

function isTerminalIssueStatus(status: string) {
  return status === "done" || status === "cancelled";
}

function shouldReturnAcceptedConfirmationToCreatorAgent(args: {
  issue: IssueResolutionContext;
  current: IssueThreadInteractionRow;
  actor: InteractionActor;
}) {
  if (!isRequestConfirmationLikeKind(args.current.kind)) return false;
  if (!args.current.createdByAgentId) return false;
  if (!args.actor.userId) return false;
  if (!args.issue.assigneeUserId) return false;
  if (args.issue.assigneeAgentId) return false;
  if (isTerminalIssueStatus(args.issue.status)) return false;
  return true;
}

function shouldSupersedeInteractionOnUserComment(interaction: UserCommentSupersedableInteraction) {
  return interaction.payload.supersedeOnUserComment === true;
}

function normalizeCreateInteractionInput(input: CreateIssueThreadInteraction): CreateIssueThreadInteraction {
  switch (input.kind) {
    case "ask_user_questions":
      return {
        ...input,
        payload: {
          ...input.payload,
          supersedeOnUserComment: input.payload.supersedeOnUserComment ?? true,
        },
      };
    case "request_confirmation":
      return {
        ...input,
        payload: {
          ...input.payload,
          supersedeOnUserComment: input.payload.supersedeOnUserComment ?? true,
        },
      };
    case "request_checkbox_confirmation":
      return {
        ...input,
        payload: {
          ...input.payload,
          supersedeOnUserComment: input.payload.supersedeOnUserComment ?? true,
        },
      };
    default:
      return input;
  }
}

function buildSupersededByCommentResult(row: IssueThreadInteractionRow, commentId: string) {
  if (row.kind === "ask_user_questions") {
    return {
      version: 1,
      answers: [],
      expirationReason: "superseded_by_comment",
      commentId,
      summaryMarkdown: null,
    } as const;
  }

  return {
    version: 1,
    outcome: "superseded_by_comment",
    commentId,
  } as const;
}

function resolveActorKind(interaction: Pick<IssueThreadInteraction, "resolvedByAgentId" | "resolvedByUserId">) {
  if (interaction.resolvedByAgentId) return "agent";
  if (interaction.resolvedByUserId) return "user";
  return "system";
}

function resolveCreatorKind(interaction: Pick<IssueThreadInteraction, "createdByAgentId" | "createdByUserId">) {
  if (interaction.createdByAgentId) return "agent";
  if (interaction.createdByUserId) return "user";
  return undefined;
}

function deriveTargetType(interaction: IssueThreadInteraction) {
  if (interaction.kind !== "request_confirmation" && interaction.kind !== "request_checkbox_confirmation") {
    return "none";
  }
  return interaction.payload.target?.type ?? "none";
}

function deriveResolutionReason(interaction: IssueThreadInteraction) {
  switch (interaction.status) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "cancelled":
      return "cancelled";
    case "expired": {
      if (interaction.kind === "ask_user_questions") {
        return interaction.result?.expirationReason ?? "expired";
      }
      if (interaction.kind === "request_confirmation" || interaction.kind === "request_checkbox_confirmation") {
        return interaction.result?.outcome ?? "expired";
      }
      return "expired";
    }
    default:
      return undefined;
  }
}

function nonNegativeInteger(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function buildInteractionResolvedCounts(interaction: IssueThreadInteraction, args?: {
  createdTaskCount?: number;
}) {
  switch (interaction.kind) {
    case "suggest_tasks":
      return {
        createdTaskCount: nonNegativeInteger(args?.createdTaskCount ?? 0),
        skippedTaskCount: nonNegativeInteger(interaction.result?.skippedClientKeys?.length ?? 0),
      };
    case "request_checkbox_confirmation":
      return {
        optionCount: nonNegativeInteger(interaction.payload.options.length),
        selectedOptionCount: nonNegativeInteger(interaction.result?.selectedOptionIds?.length ?? 0),
      };
    case "ask_user_questions":
      return {
        questionCount: nonNegativeInteger(interaction.payload.questions.length),
        answeredQuestionCount: nonNegativeInteger(interaction.result?.answers?.length ?? 0),
      };
    default:
      return {};
  }
}

async function fetchCreatorAgentRoleById(
  db: Pick<Db, "select">,
  interactions: readonly IssueThreadInteraction[],
) {
  const creatorAgentIds = [...new Set(interactions
    .map((interaction) => interaction.createdByAgentId)
    .filter((value): value is string => Boolean(value)))];
  if (creatorAgentIds.length === 0) return new Map<string, string | null>();

  const rows = await db
    .select({
      id: agents.id,
      role: agents.role,
    })
    .from(agents)
    .where(inArray(agents.id, creatorAgentIds));

  return new Map(rows.map((row) => [row.id, row.role] as const));
}

async function emitInteractionResolvedTelemetry(
  db: Pick<Db, "select">,
  interaction: IssueThreadInteraction,
  args?: { createdTaskCount?: number; creatorRoleByAgentId?: ReadonlyMap<string, string | null> },
) {
  const telemetryClient = getTelemetryClient();
  if (!telemetryClient) return;

  try {
    let roleByAgentId = args?.creatorRoleByAgentId ?? new Map<string, string | null>();
    if (!args?.creatorRoleByAgentId) {
      try {
        roleByAgentId = await fetchCreatorAgentRoleById(db, [interaction]);
      } catch (error) {
        console.error("[paperclip] Failed to load interaction.resolved creator role", error);
      }
    }
    const creatorAgentRole = interaction.createdByAgentId
      ? roleByAgentId.get(interaction.createdByAgentId) ?? undefined
      : undefined;

    trackInteractionResolved(telemetryClient, {
      interactionKind: interaction.kind,
      status: interaction.status,
      resolvedByKind: resolveActorKind(interaction),
      resolutionReason: deriveResolutionReason(interaction),
      createdByKind: resolveCreatorKind(interaction),
      creatorAgentRole,
      continuationPolicy: interaction.continuationPolicy,
      targetType: deriveTargetType(interaction),
      ...buildInteractionResolvedCounts(interaction, {
        createdTaskCount: args?.createdTaskCount,
      }),
    });
  } catch (error) {
    console.error("[paperclip] Failed to emit interaction.resolved telemetry", error);
  }
}

async function emitResolvedInteractionsTelemetry(
  db: Pick<Db, "select">,
  interactions: readonly IssueThreadInteraction[],
) {
  if (interactions.length === 0 || !getTelemetryClient()) return;
  let roleByAgentId = new Map<string, string | null>();
  try {
    roleByAgentId = await fetchCreatorAgentRoleById(db, interactions);
  } catch (error) {
    console.error("[paperclip] Failed to load interaction.resolved creator roles", error);
  }
  await Promise.all(interactions.map((interaction) =>
    emitInteractionResolvedTelemetry(db, interaction, { creatorRoleByAgentId: roleByAgentId })
  ));
}

function isCommentAtOrAfterInteraction(args: {
  commentCreatedAt: Date | string;
  interactionCreatedAt: Date | string;
}) {
  const commentCreatedAtMs = new Date(args.commentCreatedAt).getTime();
  const interactionCreatedAtMs = new Date(args.interactionCreatedAt).getTime();
  if (!Number.isFinite(commentCreatedAtMs) || !Number.isFinite(interactionCreatedAtMs)) return false;
  return commentCreatedAtMs >= interactionCreatedAtMs;
}

function buildTaskCreationOrder(tasks: ReadonlyArray<SuggestTasksInteraction["payload"]["tasks"][number]>) {
  const taskByClientKey = new Map(tasks.map((task) => [task.clientKey, task] as const));
  const ordered: Array<SuggestTasksInteraction["payload"]["tasks"][number]> = [];
  const state = new Map<string, "visiting" | "done">();

  const visit = (clientKey: string) => {
    const currentState = state.get(clientKey);
    if (currentState === "done") return;
    if (currentState === "visiting") {
      throw unprocessable("Suggested tasks contain a parentClientKey cycle");
    }

    const task = taskByClientKey.get(clientKey);
    if (!task) {
      throw unprocessable(`Unknown parentClientKey: ${clientKey}`);
    }

    state.set(clientKey, "visiting");
    if (task.parentClientKey) {
      visit(task.parentClientKey);
    }
    state.set(clientKey, "done");
    ordered.push(task);
  };

  for (const task of tasks) {
    visit(task.clientKey);
  }

  return ordered;
}

function resolveSelectedSuggestedTasks(args: {
  interaction: SuggestTasksInteraction;
  selectedClientKeys?: AcceptIssueThreadInteraction["selectedClientKeys"];
}) {
  const taskByClientKey = new Map(
    args.interaction.payload.tasks.map((task) => [task.clientKey, task] as const),
  );
  const selectedClientKeys = args.selectedClientKeys ?? args.interaction.payload.tasks.map((task) => task.clientKey);
  const selectedClientKeySet = new Set<string>();

  for (const clientKey of selectedClientKeys) {
    const task = taskByClientKey.get(clientKey);
    if (!task) {
      throw unprocessable(`Unknown suggested task clientKey: ${clientKey}`);
    }
    selectedClientKeySet.add(clientKey);
  }

  if (selectedClientKeySet.size === 0) {
    throw unprocessable("Select at least one suggested task to accept");
  }

  for (const clientKey of selectedClientKeySet) {
    let parentClientKey = taskByClientKey.get(clientKey)?.parentClientKey ?? null;
    while (parentClientKey) {
      if (!selectedClientKeySet.has(parentClientKey)) {
        throw unprocessable(`Suggested task ${clientKey} requires its parent ${parentClientKey} to also be selected`);
      }
      parentClientKey = taskByClientKey.get(parentClientKey)?.parentClientKey ?? null;
    }
  }

  return {
    selectedTasks: args.interaction.payload.tasks.filter((task) => selectedClientKeySet.has(task.clientKey)),
    skippedClientKeys: args.interaction.payload.tasks
      .filter((task) => !selectedClientKeySet.has(task.clientKey))
      .map((task) => task.clientKey),
  };
}

function resolveSelectedCheckboxConfirmationOptions(args: {
  interaction: RequestCheckboxConfirmationInteraction;
  selectedOptionIds?: AcceptIssueThreadInteraction["selectedOptionIds"];
}) {
  const optionIds = new Set(args.interaction.payload.options.map((option) => option.id));
  const selectedOptionIds = args.selectedOptionIds ?? args.interaction.payload.defaultSelectedOptionIds ?? [];
  const selectedOptionIdSet = new Set<string>();

  for (const optionId of selectedOptionIds) {
    if (!optionIds.has(optionId)) {
      throw unprocessable(`Unknown checkbox confirmation optionId: ${optionId}`);
    }
    selectedOptionIdSet.add(optionId);
  }

  const selectedCount = selectedOptionIdSet.size;
  const minSelected = args.interaction.payload.minSelected ?? 0;
  const maxSelected = args.interaction.payload.maxSelected ?? null;
  if (selectedCount < minSelected) {
    throw unprocessable(`Select at least ${minSelected} checkbox confirmation option(s)`);
  }
  if (maxSelected != null && selectedCount > maxSelected) {
    throw unprocessable(`Select no more than ${maxSelected} checkbox confirmation option(s)`);
  }

  return args.interaction.payload.options
    .filter((option) => selectedOptionIdSet.has(option.id))
    .map((option) => option.id);
}

function normalizeQuestionAnswers(args: {
  questions: AskUserQuestionsInteraction["payload"]["questions"];
  answers: RespondIssueThreadInteraction["answers"];
}) {
  const questionById = new Map(args.questions.map((question) => [question.id, question] as const));
  const answerByQuestionId = new Map<string, AskUserQuestionsAnswer>();

  for (const answer of args.answers) {
    const question = questionById.get(answer.questionId);
    if (!question) {
      throw unprocessable(`Unknown questionId: ${answer.questionId}`);
    }
    if (answerByQuestionId.has(answer.questionId)) {
      throw unprocessable(`Duplicate answer for questionId: ${answer.questionId}`);
    }

    const uniqueOptionIds = [...new Set(answer.optionIds)];
    const validOptionIds = new Set(question.options.map((option) => option.id));
    for (const optionId of uniqueOptionIds) {
      if (!validOptionIds.has(optionId)) {
        throw unprocessable(`Unknown optionId for question ${answer.questionId}: ${optionId}`);
      }
    }

    if (question.selectionMode === "single" && uniqueOptionIds.length > 1) {
      throw unprocessable(`Question ${answer.questionId} only allows one answer`);
    }

    const otherText = answer.otherText?.trim() ?? "";
    answerByQuestionId.set(answer.questionId, {
      questionId: answer.questionId,
      optionIds: uniqueOptionIds,
      ...(otherText ? { otherText } : {}),
    });
  }

  for (const question of args.questions) {
    const answer = answerByQuestionId.get(question.id);
    if (
      question.required
      && (!answer || (answer.optionIds.length === 0 && !answer.otherText))
    ) {
      throw unprocessable(`Question ${question.id} requires an answer`);
    }
  }

  return args.questions
    .map((question) => answerByQuestionId.get(question.id))
    .filter((answer): answer is AskUserQuestionsAnswer => Boolean(answer));
}

async function getIssueDocumentTargetSnapshot(db: Db | any, args: {
  companyId: string;
  issueId: string;
  target: RequestConfirmationTarget;
}) {
  if (args.target.type !== "issue_document") return null;
  const targetIssueId = args.target.issueId ?? args.issueId;
  const row = await db
    .select({
      issueId: issueDocuments.issueId,
      documentId: issueDocuments.documentId,
      key: issueDocuments.key,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(
      eq(issueDocuments.companyId, args.companyId),
      eq(issueDocuments.issueId, targetIssueId),
      eq(issueDocuments.key, args.target.key),
    ))
    .then((rows: Array<{
      issueId: string;
      documentId: string;
      key: string;
      latestRevisionId: string | null;
      latestRevisionNumber: number;
    }>) => rows[0] ?? null);

  if (!row) return null;
  if (args.target.documentId && args.target.documentId !== row.documentId) return null;
  return row;
}

function buildIssueDocumentTargetFromSnapshot(args: {
  issueId: string;
  snapshot: {
    issueId: string;
    documentId: string;
    key: string;
    latestRevisionId: string | null;
    latestRevisionNumber: number;
  } | null;
}): RequestConfirmationTarget | null {
  if (!args.snapshot?.latestRevisionId) return null;
  return {
    type: "issue_document",
    issueId: args.snapshot.issueId ?? args.issueId,
    documentId: args.snapshot.documentId,
    key: args.snapshot.key,
    revisionId: args.snapshot.latestRevisionId,
    revisionNumber: args.snapshot.latestRevisionNumber,
  };
}

function buildIssueDocumentTargetFromDocument(args: {
  issueId: string;
  document: { id: string; key: string; latestRevisionId?: string | null; latestRevisionNumber?: number | null } | null;
}): RequestConfirmationTarget | null {
  if (!args.document?.latestRevisionId) return null;
  return {
    type: "issue_document",
    issueId: args.issueId,
    documentId: args.document.id,
    key: args.document.key,
    revisionId: args.document.latestRevisionId,
    revisionNumber: args.document.latestRevisionNumber ?? null,
  };
}

async function assertRequestConfirmationTargetIsCurrent(db: Db | any, args: {
  companyId: string;
  issueId: string;
  target?: RequestConfirmationTarget | null;
}) {
  if (!args.target) return;
  if (args.target.type !== "issue_document") return;
  const snapshot = await getIssueDocumentTargetSnapshot(db, {
    companyId: args.companyId,
    issueId: args.issueId,
    target: args.target,
  });
  if (!snapshot || snapshot.latestRevisionId !== args.target.revisionId) {
    throw unprocessable("request_confirmation target must reference the current issue document revision");
  }
  if (args.target.revisionNumber && snapshot.latestRevisionNumber !== args.target.revisionNumber) {
    throw unprocessable("request_confirmation target revisionNumber must match the current issue document revision");
  }
}

async function expireStaleRequestConfirmationTarget(db: Db | any, args: {
  row: IssueThreadInteractionRow;
  actor: InteractionActor;
}): Promise<IssueThreadInteraction | null> {
  if (!isRequestConfirmationLikeKind(args.row.kind) || args.row.status !== "pending") return null;
  const interaction = hydrateInteraction(args.row) as RequestConfirmationLikeInteraction;
  const target = interaction.payload.target ?? null;
  if (!target) return null;
  if (target.type !== "issue_document") return null;

  const snapshot = await getIssueDocumentTargetSnapshot(db, {
    companyId: args.row.companyId,
    issueId: args.row.issueId,
    target,
  });
  const isCurrent =
    snapshot
    && snapshot.latestRevisionId === target.revisionId
    && (!target.revisionNumber || snapshot.latestRevisionNumber === target.revisionNumber);
  if (isCurrent) return null;

  const now = new Date();
  const currentTarget = buildIssueDocumentTargetFromSnapshot({
    issueId: args.row.issueId,
    snapshot,
  });
  const [updated] = await db
    .update(issueThreadInteractions)
    .set({
      status: "expired",
      payload: currentTarget
        ? {
            ...interaction.payload,
            target: currentTarget,
          }
        : interaction.payload,
      result: {
        version: 1,
        outcome: "stale_target",
        staleTarget: target,
      },
      resolvedByAgentId: args.actor.agentId ?? null,
      resolvedByUserId: args.actor.userId ?? null,
      resolvedAt: now,
      updatedAt: now,
    })
    .where(and(
      eq(issueThreadInteractions.id, args.row.id),
      eq(issueThreadInteractions.status, "pending"),
    ))
    .returning();

  if (!updated) {
    throw conflict("Interaction has already been resolved");
  }
  await touchIssue(db, args.row.issueId);
  const expired = hydrateInteraction(updated);
  await emitInteractionResolvedTelemetry(db, expired);
  return expired;
}

export function issueThreadInteractionService(db: Db) {
  async function getIdempotentInteraction(args: {
    issueId: string;
    companyId: string;
    idempotencyKey: string;
  }) {
    return db
      .select()
      .from(issueThreadInteractions)
      .where(and(
        eq(issueThreadInteractions.companyId, args.companyId),
        eq(issueThreadInteractions.issueId, args.issueId),
        eq(issueThreadInteractions.idempotencyKey, args.idempotencyKey),
      ))
      .then((rows) => rows[0] ?? null);
  }

  async function assertIssueWorkspaceFinalizedForAccept(args: {
    db: Pick<Db, "select">;
    issue: { id: string; companyId: string };
    sourceRunId: string | null;
  }) {
    if (!args.sourceRunId) return;

    const executionWorkspaceId = await args.db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues)
      .where(eq(issues.id, args.issue.id))
      .then((rows: Array<{ executionWorkspaceId: string | null }>) => rows[0]?.executionWorkspaceId ?? null);

    if (!executionWorkspaceId) return;

    const isFinalized = await runWorkspaceIsFinalized(
      args.db,
      args.issue.companyId,
      executionWorkspaceId,
      args.sourceRunId,
    );
    if (isFinalized) return;

    throw conflict(
      "Cannot accept interaction: the run that created this interaction has not finished syncing its workspace. "
        + "Retry once the local worktree has finished syncing.",
      { executionWorkspaceId, sourceRunId: args.sourceRunId },
    );
  }

  async function getPendingInteractionForResolution(args: {
    issue: { id: string; companyId: string };
    interactionId: string;
  }) {
    const current = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, args.interactionId))
      .then((rows) => rows[0] ?? null);

    if (!current) throw notFound("Interaction not found");
    if (current.companyId !== args.issue.companyId || current.issueId !== args.issue.id) {
      throw notFound("Interaction not found");
    }
    if (current.status !== "pending") {
      throw conflict("Interaction has already been resolved");
    }
    return current;
  }

  async function acceptRequestConfirmation(args: {
    issue: { id: string; companyId: string };
    current: IssueThreadInteractionRow;
    input: AcceptIssueThreadInteraction;
    actor: InteractionActor;
  }): Promise<{
    interaction: IssueThreadInteraction;
    continuationIssue: IssueWakeTarget | null;
  }> {
    const expired = await expireStaleRequestConfirmationTarget(db, {
      row: args.current,
      actor: args.actor,
    });
    if (expired) {
      return { interaction: expired, continuationIssue: null };
    }

    const interaction = hydrateInteraction(args.current);
    const selectedOptionIds =
      interaction.kind === "request_checkbox_confirmation"
        ? resolveSelectedCheckboxConfirmationOptions({
            interaction,
            selectedOptionIds: args.input.selectedOptionIds,
          })
        : undefined;

    const now = new Date();
    const result = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(issueThreadInteractions)
        .set({
          status: "accepted",
          result: {
            version: 1,
            outcome: "accepted",
            ...(selectedOptionIds ? { selectedOptionIds } : {}),
          },
          resolvedByAgentId: args.actor.agentId ?? null,
          resolvedByUserId: args.actor.userId ?? null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(issueThreadInteractions.id, args.current.id),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      const issueContext = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
        })
        .from(issues)
        .where(eq(issues.id, args.issue.id))
        .then((rows: IssueResolutionContext[]) => rows[0] ?? null);

      if (!issueContext || issueContext.companyId !== args.issue.companyId) {
        throw notFound("Issue not found");
      }

      let continuationIssue: IssueWakeTarget | null = null;
      if (shouldReturnAcceptedConfirmationToCreatorAgent({
        issue: issueContext,
        current: args.current,
        actor: args.actor,
      })) {
        const returnStatus = issueContext.status === "blocked" ? "blocked" : "todo";
        const returnedIssue = await issueService(db).update(args.issue.id, {
          status: returnStatus,
          assigneeAgentId: args.current.createdByAgentId,
          assigneeUserId: null,
          actorAgentId: args.actor.agentId ?? null,
          actorUserId: args.actor.userId ?? null,
        }, tx);

        if (returnedIssue) {
          continuationIssue = {
            id: returnedIssue.id,
            assigneeAgentId: returnedIssue.assigneeAgentId ?? null,
            assigneeUserId: returnedIssue.assigneeUserId ?? null,
            status: returnedIssue.status,
          };
        }
      } else {
        await touchIssue(tx, args.issue.id);
      }

      return {
        interaction: hydrateInteraction(updated),
        continuationIssue,
      };
    });
    await emitInteractionResolvedTelemetry(db, result.interaction);
    return result;
  }

  async function rejectRequestConfirmation(args: {
    issue: { id: string; companyId: string };
    current: IssueThreadInteractionRow;
    input: RejectIssueThreadInteraction;
    actor: InteractionActor;
  }): Promise<IssueThreadInteraction> {
    const expired = await expireStaleRequestConfirmationTarget(db, {
      row: args.current,
      actor: args.actor,
    });
    if (expired) {
      return expired;
    }

    const interaction = hydrateInteraction(args.current) as RequestConfirmationLikeInteraction;
    const reason = args.input.reason?.trim() ?? "";
    if (interaction.payload.rejectRequiresReason === true && reason.length === 0) {
      throw unprocessable("A decline reason is required for this confirmation");
    }

    const now = new Date();
    const [updated] = await db
      .update(issueThreadInteractions)
      .set({
        status: "rejected",
        result: {
          version: 1,
          outcome: "rejected",
          reason: reason || null,
        },
        resolvedByAgentId: args.actor.agentId ?? null,
        resolvedByUserId: args.actor.userId ?? null,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(and(
        eq(issueThreadInteractions.id, args.current.id),
        eq(issueThreadInteractions.status, "pending"),
      ))
      .returning();

    if (!updated) {
      throw conflict("Interaction has already been resolved");
    }
    await touchIssue(db, args.issue.id);
    const rejected = hydrateInteraction(updated);
    await emitInteractionResolvedTelemetry(db, rejected);
    return rejected;
  }

  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, issueId))
        .orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id));

      return rows.map((row) => hydrateInteraction(row));
    },

    getById: async (interactionId: string) => {
      const row = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      return row ? hydrateInteraction(row) : null;
    },

    create: async (
      issue: { id: string; companyId: string },
      input: CreateIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      const data = normalizeCreateInteractionInput(createIssueThreadInteractionSchema.parse(input));

      if (data.idempotencyKey) {
        const existing = await getIdempotentInteraction({
          issueId: issue.id,
          companyId: issue.companyId,
          idempotencyKey: data.idempotencyKey,
        });
        if (existing) {
          if (!isEquivalentCreateRequest(existing, data, actor)) {
            throw conflict("Interaction idempotency key already exists for a different request", {
              idempotencyKey: data.idempotencyKey,
            });
          }
          return hydrateInteraction(existing);
        }
      }

      if (data.sourceCommentId) {
        const sourceComment = await db
          .select({
            companyId: issueComments.companyId,
            issueId: issueComments.issueId,
          })
          .from(issueComments)
          .where(eq(issueComments.id, data.sourceCommentId))
          .then((rows) => rows[0] ?? null);
        if (!sourceComment || sourceComment.companyId !== issue.companyId || sourceComment.issueId !== issue.id) {
          throw unprocessable("sourceCommentId must belong to the same issue and company");
        }
      }

      if (data.sourceRunId) {
        const sourceRun = await db
          .select({
            companyId: heartbeatRuns.companyId,
          })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.id, data.sourceRunId))
          .then((rows) => rows[0] ?? null);
        if (!sourceRun || sourceRun.companyId !== issue.companyId) {
          throw unprocessable("sourceRunId must belong to the same company");
        }
      }

      if (data.kind === "request_confirmation" || data.kind === "request_checkbox_confirmation") {
        await assertRequestConfirmationTargetIsCurrent(db, {
          companyId: issue.companyId,
          issueId: issue.id,
          target: data.payload.target ?? null,
        });
      }

      let created: IssueThreadInteractionRow;
      try {
        [created] = await db
          .insert(issueThreadInteractions)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            kind: data.kind,
            status: "pending",
            continuationPolicy: data.continuationPolicy,
            idempotencyKey: data.idempotencyKey ?? null,
            sourceCommentId: data.sourceCommentId ?? null,
            sourceRunId: data.sourceRunId ?? null,
            title: data.title ?? null,
            summary: data.summary ?? null,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            payload: data.payload,
          })
          .returning();
      } catch (error) {
        if (!data.idempotencyKey || !isIssueThreadInteractionIdempotencyConflict(error)) {
          throw error;
        }
        const existing = await getIdempotentInteraction({
          issueId: issue.id,
          companyId: issue.companyId,
          idempotencyKey: data.idempotencyKey,
        });
        if (!existing) throw error;
        if (!isEquivalentCreateRequest(existing, data, actor)) {
          throw conflict("Interaction idempotency key already exists for a different request", {
            idempotencyKey: data.idempotencyKey,
          });
        }
        return hydrateInteraction(existing);
      }

      await touchIssue(db, issue.id);
      return hydrateInteraction(created);
    },

    acceptInteraction: async (
      issue: { id: string; companyId: string; projectId: string | null; goalId: string | null },
      interactionId: string,
      input: AcceptIssueThreadInteraction,
      actor: InteractionActor,
    ): Promise<ResolvedInteractionResult> => {
      const data = acceptIssueThreadInteractionSchema.parse(input);
      const current = await getPendingInteractionForResolution({ issue, interactionId });
      switch (current.kind) {
        case "suggest_tasks":
          // Accepting suggest_tasks only creates follow-up issues; it does not
          // approve code state or move the source workspace forward, so the
          // workspace_finalize gate (PAPA-440) does not apply here.
          return issueThreadInteractionService(db).acceptSuggestedTasks(issue, interactionId, data, actor);
        case "request_confirmation": {
          await assertIssueWorkspaceFinalizedForAccept({ db, issue, sourceRunId: current.sourceRunId });
          const accepted = await acceptRequestConfirmation({
            issue,
            current,
            input: data,
            actor,
          });
          return {
            interaction: accepted.interaction,
            continuationIssue: accepted.continuationIssue,
            createdIssues: [],
          };
        }
        case "request_checkbox_confirmation": {
          await assertIssueWorkspaceFinalizedForAccept({ db, issue, sourceRunId: current.sourceRunId });
          const accepted = await acceptRequestConfirmation({
            issue,
            current,
            input: data,
            actor,
          });
          return {
            interaction: accepted.interaction,
            continuationIssue: accepted.continuationIssue,
            createdIssues: [],
          };
        }
        default:
          throw unprocessable(`Interactions of kind ${current.kind} cannot be accepted`);
      }
    },

    acceptSuggestedTasks: async (
      issue: { id: string; companyId: string; projectId: string | null; goalId: string | null },
      interactionId: string,
      input: AcceptIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Interaction not found");
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "suggest_tasks") {
        throw unprocessable("Only suggest_tasks interactions can be accepted");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const interaction = hydrateInteraction(current) as SuggestTasksInteraction;
      const { selectedTasks, skippedClientKeys } = resolveSelectedSuggestedTasks({
        interaction,
        selectedClientKeys: input.selectedClientKeys,
      });
      const orderedTasks = buildTaskCreationOrder(selectedTasks);
      const explicitParentIds = [...new Set([
        issue.id,
        ...(interaction.payload.defaultParentId ? [interaction.payload.defaultParentId] : []),
        ...selectedTasks
          .map((task) => task.parentId ?? null)
          .filter((value): value is string => Boolean(value)),
      ])];

      const parentRows = explicitParentIds.length === 0
        ? []
        : await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            companyId: issues.companyId,
          })
          .from(issues)
          .where(and(eq(issues.companyId, issue.companyId), inArray(issues.id, explicitParentIds)));
      if (parentRows.length !== explicitParentIds.length) {
        throw unprocessable("Suggested tasks reference parent issues outside this company or issue tree");
      }

      const parentById = new Map(parentRows.map((row) => [row.id, row] as const));
      const createdByClientKey = new Map<string, SuggestTasksResultCreatedTask>();
      const createdWakeTargets: IssueWakeTarget[] = [];

      await db.transaction(async (tx) => {
        const resolvedAt = new Date();
        const [claimed] = await tx
          .update(issueThreadInteractions)
          .set({
            status: "accepted",
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt,
            updatedAt: resolvedAt,
          })
          .where(and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();

        if (!claimed) {
          throw conflict("Interaction has already been resolved");
        }

        for (const task of orderedTasks) {
          const parentIssueId = task.parentClientKey
            ? createdByClientKey.get(task.parentClientKey)?.issueId ?? null
            : task.parentId ?? interaction.payload.defaultParentId ?? issue.id;
          if (!parentIssueId) {
            throw unprocessable(`Unable to resolve parent for suggested task ${task.clientKey}`);
          }

          const { issue: createdIssue } = await issueService(tx as unknown as Db).createChild(parentIssueId, {
            title: task.title,
            description: task.description ?? null,
            status: "todo",
            workMode: task.workMode ?? "standard",
            priority: task.priority ?? "medium",
            assigneeAgentId: task.assigneeAgentId ?? null,
            assigneeUserId: task.assigneeUserId ?? null,
            projectId: task.projectId ?? issue.projectId,
            goalId: task.goalId ?? issue.goalId,
            billingCode: task.billingCode ?? null,
            createdByAgentId: actor.agentId ?? null,
            createdByUserId: actor.userId ?? null,
            actorAgentId: actor.agentId ?? null,
            actorUserId: actor.userId ?? null,
          } as Parameters<ReturnType<typeof issueService>["createChild"]>[1]);

          const parentIdentifier = createdByClientKey.get(task.parentClientKey ?? "")?.identifier
            ?? parentById.get(parentIssueId)?.identifier
            ?? null;
          createdByClientKey.set(task.clientKey, {
            clientKey: task.clientKey,
            issueId: createdIssue.id,
            identifier: createdIssue.identifier ?? null,
            title: createdIssue.title,
            parentIssueId,
            parentIdentifier,
          });
          createdWakeTargets.push({
            id: createdIssue.id,
            assigneeAgentId: createdIssue.assigneeAgentId ?? null,
            status: createdIssue.status,
          });
        }

        const [updated] = await tx
          .update(issueThreadInteractions)
          .set({
            result: {
              version: 1,
              createdTasks: [...createdByClientKey.values()],
              ...(skippedClientKeys.length > 0 ? { skippedClientKeys } : {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(issueThreadInteractions.id, interactionId))
          .returning();

        await touchIssue(tx, issue.id);
        current.status = updated.status;
        current.result = updated.result;
        current.resolvedByAgentId = updated.resolvedByAgentId;
        current.resolvedByUserId = updated.resolvedByUserId;
        current.resolvedAt = updated.resolvedAt;
        current.updatedAt = updated.updatedAt;
      });

      const accepted = hydrateInteraction(current);
      await emitInteractionResolvedTelemetry(db, accepted, {
        createdTaskCount: createdWakeTargets.length,
      });
      return {
        interaction: accepted,
        createdIssues: createdWakeTargets,
      };
    },

    rejectInteraction: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      input: RejectIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      const data = rejectIssueThreadInteractionSchema.parse(input);
      const current = await getPendingInteractionForResolution({ issue, interactionId });
      switch (current.kind) {
        case "suggest_tasks":
          return issueThreadInteractionService(db).rejectSuggestedTasks(issue, interactionId, data, actor, current);
        case "request_confirmation":
        case "request_checkbox_confirmation":
          return rejectRequestConfirmation({
            issue,
            current,
            input: data,
            actor,
          });
        default:
          throw unprocessable(`Interactions of kind ${current.kind} cannot be rejected`);
      }
    },

    rejectSuggestedTasks: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      input: RejectIssueThreadInteraction,
      actor: InteractionActor,
      current: IssueThreadInteractionRow,
    ) => {
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "suggest_tasks") {
        throw unprocessable("Only suggest_tasks interactions can be rejected");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const [updated] = await db
        .update(issueThreadInteractions)
        .set({
          status: "rejected",
          result: {
            version: 1,
            rejectionReason: input.reason?.trim() || null,
          },
          resolvedByAgentId: actor.agentId ?? null,
          resolvedByUserId: actor.userId ?? null,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      await touchIssue(db, issue.id);
      const rejected = hydrateInteraction(updated);
      await emitInteractionResolvedTelemetry(db, rejected);
      return rejected;
    },

    expireRequestConfirmationsSupersededByComment: async (
      issue: { id: string; companyId: string },
      comment: { id: string; createdAt: Date | string; authorUserId?: string | null },
      actor: InteractionActor,
    ) => {
      if (!comment.authorUserId) return [];

      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          inArray(issueThreadInteractions.kind, [...USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS]),
          eq(issueThreadInteractions.status, "pending"),
        ));

      const superseded = rows.filter((row) => {
        if (!isUserCommentSupersedableKind(row.kind)) return false;
        const interaction = hydrateInteraction(row) as UserCommentSupersedableInteraction;
        return (
          shouldSupersedeInteractionOnUserComment(interaction)
          && isCommentAtOrAfterInteraction({
            commentCreatedAt: comment.createdAt,
            interactionCreatedAt: row.createdAt,
          })
        );
      });

      if (superseded.length === 0) return [];

      const now = new Date();
      const expired: IssueThreadInteraction[] = [];
      for (const row of superseded) {
        const [updated] = await db
          .update(issueThreadInteractions)
          .set({
            status: "expired",
            result: buildSupersededByCommentResult(row, comment.id),
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(issueThreadInteractions.id, row.id),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();
        if (updated) expired.push(hydrateInteraction(updated));
      }

      if (expired.length > 0) {
        await touchIssue(db, issue.id);
        await emitResolvedInteractionsTelemetry(db, expired);
      }
      return expired;
    },

    expireRequestConfirmationsSupersededByHistoricalComments: async (
      issue: { id: string; companyId: string },
    ) => {
      const [rows, comments] = await Promise.all([
        db
          .select()
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.companyId, issue.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
            inArray(issueThreadInteractions.kind, [...USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS]),
            eq(issueThreadInteractions.status, "pending"),
          )),
        db
          .select()
          .from(issueComments)
          .where(and(
            eq(issueComments.companyId, issue.companyId),
            eq(issueComments.issueId, issue.id),
            isNotNull(issueComments.authorUserId),
          ))
          .orderBy(asc(issueComments.createdAt)),
      ]);

      if (rows.length === 0 || comments.length === 0) return [];

      const now = new Date();
      const expired: IssueThreadInteraction[] = [];
      const supersededByComment = new Map<
        string,
        {
          comment: (typeof comments)[number];
          rowIds: string[];
        }
      >();
      for (const row of rows) {
        if (!isUserCommentSupersedableKind(row.kind)) continue;
        const interaction = hydrateInteraction(row) as UserCommentSupersedableInteraction;
        if (!shouldSupersedeInteractionOnUserComment(interaction)) continue;

        const supersedingComment = comments.find((comment) => isCommentAtOrAfterInteraction({
          commentCreatedAt: comment.createdAt,
          interactionCreatedAt: row.createdAt,
        }));
        if (!supersedingComment) continue;

        const group = supersededByComment.get(supersedingComment.id);
        if (group) {
          group.rowIds.push(row.id);
        } else {
          supersededByComment.set(supersedingComment.id, {
            comment: supersedingComment,
            rowIds: [row.id],
          });
        }
      }

      const rowById = new Map(rows.map((row) => [row.id, row] as const));
      for (const { comment, rowIds } of supersededByComment.values()) {
        const commentRows = rowIds
          .map((rowId) => rowById.get(rowId))
          .filter((row): row is IssueThreadInteractionRow => Boolean(row));
        const questionRowIds = commentRows
          .filter((row) => row.kind === "ask_user_questions")
          .map((row) => row.id);
        const confirmationRowIds = commentRows
          .filter((row) => isRequestConfirmationLikeKind(row.kind))
          .map((row) => row.id);

        if (questionRowIds.length > 0) {
          const sampleQuestionRow = commentRows.find((row) => row.kind === "ask_user_questions");
          if (!sampleQuestionRow) continue;
          const updatedRows = await db
            .update(issueThreadInteractions)
            .set({
              status: "expired",
              result: buildSupersededByCommentResult(sampleQuestionRow, comment.id),
              resolvedByAgentId: null,
              resolvedByUserId: comment.authorUserId,
              resolvedAt: now,
              updatedAt: now,
            })
            .where(and(
              inArray(issueThreadInteractions.id, questionRowIds),
              eq(issueThreadInteractions.status, "pending"),
            ))
            .returning();
          expired.push(...updatedRows.map(hydrateInteraction));
        }

        if (confirmationRowIds.length > 0) {
          const sampleConfirmationRow = commentRows.find((row) => isRequestConfirmationLikeKind(row.kind));
          if (!sampleConfirmationRow) continue;
          const updatedRows = await db
            .update(issueThreadInteractions)
            .set({
              status: "expired",
              result: buildSupersededByCommentResult(sampleConfirmationRow, comment.id),
              resolvedByAgentId: null,
              resolvedByUserId: comment.authorUserId,
              resolvedAt: now,
              updatedAt: now,
            })
            .where(and(
              inArray(issueThreadInteractions.id, confirmationRowIds),
              eq(issueThreadInteractions.status, "pending"),
            ))
            .returning();
          expired.push(...updatedRows.map(hydrateInteraction));
        }
      }

      if (expired.length > 0) {
        await touchIssue(db, issue.id);
        await emitResolvedInteractionsTelemetry(db, expired);
      }
      return expired;
    },

    expireStaleRequestConfirmationsForIssueDocument: async (
      issue: { id: string; companyId: string },
      document: { id: string; key: string; latestRevisionId?: string | null; latestRevisionNumber?: number | null } | null,
      actor: InteractionActor,
    ) => {
      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          inArray(issueThreadInteractions.kind, [...REQUEST_CONFIRMATION_INTERACTION_KINDS]),
          eq(issueThreadInteractions.status, "pending"),
        ));

      const staleRows = rows.filter((row) => {
        const interaction = hydrateInteraction(row) as RequestConfirmationLikeInteraction;
        const target = interaction.payload.target;
        if (!target || target.type !== "issue_document") return false;
        const targetIssueId = target.issueId ?? issue.id;
        if (targetIssueId !== issue.id) return false;
        if (document && target.documentId && target.documentId !== document.id) return false;
        if (document && target.key !== document.key) return false;
        if (!document) return true;
        return (
          target.revisionId !== document.latestRevisionId
          || (target.revisionNumber != null && target.revisionNumber !== document.latestRevisionNumber)
        );
      });

      if (staleRows.length === 0) return [];

      const now = new Date();
      const expired: IssueThreadInteraction[] = [];
      for (const row of staleRows) {
        const interaction = hydrateInteraction(row) as RequestConfirmationLikeInteraction;
        const target = interaction.payload.target ?? null;
        const currentTarget = buildIssueDocumentTargetFromDocument({
          issueId: issue.id,
          document,
        });
        const [updated] = await db
          .update(issueThreadInteractions)
          .set({
            status: "expired",
            payload: currentTarget
              ? {
                  ...interaction.payload,
                  target: currentTarget,
                }
              : interaction.payload,
            result: {
              version: 1,
              outcome: "stale_target",
              staleTarget: target,
            },
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(issueThreadInteractions.id, row.id),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();
        if (updated) expired.push(hydrateInteraction(updated));
      }

      if (expired.length > 0) {
        await touchIssue(db, issue.id);
        await emitResolvedInteractionsTelemetry(db, expired);
      }
      return expired;
    },

    answerQuestions: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      input: RespondIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Interaction not found");
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "ask_user_questions") {
        throw unprocessable("Only ask_user_questions interactions can be answered");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const interaction = hydrateInteraction(current) as AskUserQuestionsInteraction;
      const normalizedAnswers = normalizeQuestionAnswers({
        questions: interaction.payload.questions,
        answers: input.answers,
      });

      const [updated] = await db
        .update(issueThreadInteractions)
        .set({
          status: "answered",
          result: {
            version: 1,
            answers: normalizedAnswers,
            summaryMarkdown: input.summaryMarkdown ?? null,
          },
          resolvedByAgentId: actor.agentId ?? null,
          resolvedByUserId: actor.userId ?? null,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      await touchIssue(db, issue.id);
      const answered = hydrateInteraction(updated);
      await emitInteractionResolvedTelemetry(db, answered);
      return answered;
    },

    cancelQuestions: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      input: CancelIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      const data = cancelIssueThreadInteractionSchema.parse(input);
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw notFound("Interaction not found");
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw notFound("Interaction not found");
      }
      if (current.kind !== "ask_user_questions") {
        throw unprocessable("Only ask_user_questions interactions can be cancelled");
      }
      if (current.status !== "pending") {
        throw conflict("Interaction has already been resolved");
      }

      const reason = data.reason?.trim() || null;
      const [updated] = await db
        .update(issueThreadInteractions)
        .set({
          status: "cancelled",
          result: {
            version: 1,
            answers: [],
            cancelled: true,
            cancellationReason: reason,
            summaryMarkdown: null,
          },
          resolvedByAgentId: actor.agentId ?? null,
          resolvedByUserId: actor.userId ?? null,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw conflict("Interaction has already been resolved");
      }

      await touchIssue(db, issue.id);
      const cancelled = hydrateInteraction(updated);
      await emitInteractionResolvedTelemetry(db, cancelled);
      return cancelled;
    },
  };
}
