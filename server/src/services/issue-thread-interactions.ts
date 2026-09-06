import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companySecretProposals,
  companies,
  documents,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueQuestionResponseDeliveries,
  issueThreadInteractions,
  issues,
  toolActionRequests,
  toolOauthStates,
} from "@paperclipai/db";
import { trackInteractionCreated, trackInteractionResolved } from "@paperclipai/shared/telemetry";
import type {
  AcceptIssueThreadInteraction,
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  CancelIssueThreadInteraction,
  ConnectionIntentInteraction,
  CreateIssueThreadInteraction,
  InteractionResolverGovernance,
  IssueReviewPolicy,
  IssueThreadInteraction,
  IssueThreadInteractionCanonicalResolverPolicy,
  IssueThreadInteractionEffectiveResolverPolicySource,
  IssueThreadInteractionKind,
  IssueThreadInteractionResolverPolicy,
  IssueThreadInteractionResolverPolicyProvenance,
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  RequestConfirmationTarget,
  RequestItemVerdictsInteraction,
  RequestItemVerdictsResult,
  RequestItemVerdictsResultItem,
  RejectIssueThreadInteraction,
  SkipIssueThreadInteraction,
  RespondIssueThreadInteraction,
  SuggestTasksInteraction,
  SuggestTasksResultCreatedTask,
  SubmitIssueThreadInteractionVerdicts,
  WithdrawIssueThreadInteraction,
} from "@paperclipai/shared";
import {
  acceptIssueThreadInteractionSchema,
  askUserQuestionsPayloadSchema,
  askUserQuestionsResultSchema,
  cancelIssueThreadInteractionSchema,
  connectionIntentPayloadSchema,
  connectionIntentResultSchema,
  createIssueThreadInteractionSchema,
  legacyIssueThreadInteractionResolverPolicyAlias,
  normalizeIssueThreadInteractionResolverPolicy,
  rejectIssueThreadInteractionSchema,
  requestCheckboxConfirmationPayloadSchema,
  requestCheckboxConfirmationResultSchema,
  requestConfirmationPayloadSchema,
  requestConfirmationResultSchema,
  requestItemVerdictsPayloadSchema,
  requestItemVerdictsResultSchema,
  skipIssueThreadInteractionSchema,
  suggestTasksPayloadSchema,
  suggestTasksResultSchema,
  submitIssueThreadInteractionVerdictsSchema,
  withdrawIssueThreadInteractionSchema,
} from "@paperclipai/shared";
import { z } from "zod";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { getTelemetryClient } from "../telemetry.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import {
  assertIssueReviewVerdictActorAllowed,
  isIssueReviewVerdictInteraction,
} from "./issue-review-policy.js";
import {
  issueService,
  readAcceptedPlanConfirmationTarget,
  runWorkspaceIsFinalized,
} from "./issues.js";
import { questionResponseDeliveryValues } from "./question-response-delivery.js";
import {
  assertIssueThreadInteractionResolverAudience,
  canonicalizeStoredResolverPolicy,
  issueThreadInteractionResolutionError,
  type IssueThreadInteractionResolverRestriction,
} from "./issue-thread-interaction-resolution.js";
import {
  createPullRequestMergeStateResolver,
  extractGitHubPullRequestReferences,
  setBoundedPullRequestCacheEntry,
  type GitHubPullRequestReference,
  type PullRequestMergeState,
} from "./github-pull-request-merge.js";

export { extractGitHubPullRequestReferences } from "./github-pull-request-merge.js";
export type { GitHubPullRequestReference } from "./github-pull-request-merge.js";

type InteractionActor = {
  agentId?: string | null;
  runId?: string | null;
  userId?: string | null;
  systemId?: string | null;
  resolverPolicyRestriction?:
    | IssueThreadInteractionCanonicalResolverPolicy
    | IssueThreadInteractionResolverRestriction
    | null;
  suggestedTaskEffectsAuthorized?: boolean;
  resolutionDetails?: Record<string, unknown>;
};

type CreateInteractionOptions = {
  /** Keep independently owned pending cards actionable. Internal runtime bridges use this. */
  supersedePendingSiblingInteractions?: boolean;
};

type InteractionWakeup = (agentId: string, options: {
  source: "automation";
  triggerDetail: "system";
  reason: "issue_commented";
  payload: Record<string, unknown>;
  idempotencyKey: string;
  requestedByActorType: "system";
  requestedByActorId: string;
  contextSnapshot: Record<string, unknown>;
}) => Promise<unknown>;

export type IssueThreadInteractionServiceOptions = {
  resolvePullRequestState?: (
    companyId: string,
    reference: GitHubPullRequestReference,
  ) => Promise<PullRequestMergeState>;
  wakeup?: InteractionWakeup;
  pullRequestCacheTtlMs?: number;
  now?: () => Date;
};

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type InteractionResolutionMutationOptions = {
  afterResolveInTransaction?: (
    tx: DbTransaction,
    interaction: IssueThreadInteraction,
  ) => Promise<void>;
};

const GITHUB_PULL_REQUEST_URL_PATTERN = /https:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)/gi;
const GITHUB_PULL_REQUEST_SHORTHAND_PATTERN = /(^|[^A-Za-z0-9_.-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9][0-9]*)\b/g;
const MERGE_CONFIRMATION_INTENT_PATTERN = /^(?:please\s+)?(?:confirm(?:\s+that)?\s+.{0,80}\s+)?(?:merge|merged)\b|\bready\s+to\s+merge\b/i;
const MERGE_CONFIRMATION_ALLOWED_WORDS = new Set([
  "all",
  "and",
  "approved",
  "are",
  "both",
  "checks",
  "ci",
  "confirm",
  "github",
  "green",
  "is",
  "it",
  "link",
  "linked",
  "links",
  "merge",
  "merged",
  "merging",
  "passed",
  "passing",
  "please",
  "pr",
  "primary",
  "prs",
  "pull",
  "ready",
  "reference",
  "references",
  "request",
  "requests",
  "review",
  "secondary",
  "tests",
  "that",
  "the",
  "these",
  "this",
  "to",
  "url",
]);

function isMergeConfirmationOnlyText(value: string) {
  GITHUB_PULL_REQUEST_URL_PATTERN.lastIndex = 0;
  const withoutUrls = value.replace(GITHUB_PULL_REQUEST_URL_PATTERN, " pr_reference ");
  GITHUB_PULL_REQUEST_SHORTHAND_PATTERN.lastIndex = 0;
  const withoutReferences = withoutUrls.replace(
    GITHUB_PULL_REQUEST_SHORTHAND_PATTERN,
    (_match, prefix: string) => `${prefix} pr_reference `,
  );
  const normalized = withoutReferences
    .replace(/\b(?:github-)?pr-[1-9][0-9]*\b/gi, " pr_reference ")
    .replace(/[`*_\[\]{}()<>:;,.!?"'=+&|\\/-]+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return normalized
    .split(/\s+/)
    .every((word) => word === "pr_reference" || MERGE_CONFIRMATION_ALLOWED_WORDS.has(word));
}

export function getMergeConfirmationPullRequestReferences(
  row: Pick<IssueThreadInteractionRow, "kind" | "title" | "summary" | "payload">,
) {
  if (row.kind !== "request_confirmation") return [];
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as unknown as Record<string, unknown>
    : null;
  if (!payload || payload.toolAction !== undefined || payload.secretProposal !== undefined) return [];

  const target = payload.target && typeof payload.target === "object" && !Array.isArray(payload.target)
    ? payload.target as Record<string, unknown>
    : null;
  // Plan/document confirmations and governed action cards must never inherit
  // merge-confirmation authority merely because their prose links to a PR.
  if (target?.type === "issue_document") return [];

  const intentValues = [row.title, row.summary, payload.prompt, payload.acceptLabel];
  const intentText = intentValues.filter((value): value is string => typeof value === "string").join("\n");
  if (!MERGE_CONFIRMATION_INTENT_PATTERN.test(intentText)) return [];

  const trustedTextValues = [
    ...intentValues,
    payload.detailsMarkdown,
    target?.key,
    target?.label,
    target?.href,
  ];
  // System acceptance is intentionally fail-closed: after replacing recognized
  // PR references, every trusted field must contain merge-only vocabulary. This
  // prevents an otherwise valid merge prompt from smuggling an additional action
  // that a governed-action denylist did not anticipate.
  if (!trustedTextValues.every((value) => typeof value !== "string" || isMergeConfirmationOnlyText(value))) {
    return [];
  }

  return extractGitHubPullRequestReferences(trustedTextValues);
}

const ISSUE_THREAD_INTERACTION_IDEMPOTENCY_CONSTRAINT =
  "issue_thread_interactions_company_issue_idempotency_uq";

type IssueWakeTarget = {
  id: string;
  assigneeAgentId: string | null;
  assigneeUserId?: string | null;
  status: string;
  workMode?: string;
};

type ResolvedInteractionResult = {
  interaction: IssueThreadInteraction;
  createdIssues: IssueWakeTarget[];
  continuationIssue?: IssueWakeTarget | null;
};

type IssueThreadInteractionRow = typeof issueThreadInteractions.$inferSelect;
type IssueTouchDb = Pick<Db, "update">;

function isNativeCompletionReview(row: Pick<IssueThreadInteractionRow, "kind" | "payload">) {
  if (row.kind !== "request_confirmation") return false;
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as unknown as Record<string, unknown>
    : {};
  const target = payload.target && typeof payload.target === "object" && !Array.isArray(payload.target)
    ? payload.target as Record<string, unknown>
    : {};
  return target.type === "custom" && target.key === "native_completion_review";
}

export const DEFAULT_RESOLVER_POLICY_BY_KIND: Record<
  IssueThreadInteractionKind,
  IssueThreadInteractionCanonicalResolverPolicy
> = {
  suggest_tasks: "anyone",
  ask_user_questions: "anyone",
  request_confirmation: "anyone",
  request_checkbox_confirmation: "anyone",
  request_item_verdicts: "anyone",
  connection_intent: "human_only",
};

const RESOLVER_POLICY_RESTRICTION_RANK: Record<IssueThreadInteractionCanonicalResolverPolicy, number> = {
  anyone: 0,
  not_creator: 1,
  human_only: 2,
};

export function resolveInteractionPolicy(args: {
  kind: IssueThreadInteractionKind;
  requested?: IssueThreadInteractionResolverPolicy;
  governance: InteractionResolverGovernance;
  hasToolAction: boolean;
  hasSecretProposal?: boolean;
}) {
  const kindGovernance = args.governance[args.kind];
  const requestedPolicyInput = args.requested
    ?? kindGovernance?.defaultPolicy
    ?? DEFAULT_RESOLVER_POLICY_BY_KIND[args.kind];
  const requestedResolverPolicy = normalizeIssueThreadInteractionResolverPolicy(requestedPolicyInput);
  const resolverPolicyProvenance: IssueThreadInteractionResolverPolicyProvenance =
    args.requested === undefined ? "inherited" : "explicit";

  let effectiveResolverPolicy = requestedResolverPolicy;
  let effectiveResolverPolicySource: IssueThreadInteractionEffectiveResolverPolicySource = "requested";
  if (args.hasToolAction || args.hasSecretProposal) {
    effectiveResolverPolicy = "human_only";
    effectiveResolverPolicySource = "governed_action";
  } else if (kindGovernance?.cap) {
    const cap = normalizeIssueThreadInteractionResolverPolicy(kindGovernance.cap);
    if (RESOLVER_POLICY_RESTRICTION_RANK[cap] > RESOLVER_POLICY_RESTRICTION_RANK[effectiveResolverPolicy]) {
      effectiveResolverPolicy = cap;
      effectiveResolverPolicySource = "company_cap";
    }
  }
  return {
    requestedResolverPolicy,
    effectiveResolverPolicy,
    resolverPolicyProvenance,
    effectiveResolverPolicySource,
  } as const;
}

function resolverActor(actor: InteractionActor) {
  if (actor.systemId) return { type: "system" as const, systemId: actor.systemId };
  if (actor.agentId) {
    return { type: "agent" as const, agentId: actor.agentId, runId: actor.runId };
  }
  if (actor.userId) return { type: "user" as const, userId: actor.userId };
  // Missing principals must fail closed. Internal maintenance paths that are
  // intentionally system-owned provide an explicit systemId.
  return { type: "agent" as const, agentId: null, runId: null };
}

function assertInteractionResolutionAllowed(current: IssueThreadInteractionRow, actor: InteractionActor) {
  return assertIssueThreadInteractionResolverAudience({
    actor: resolverActor(actor),
    interaction: current,
    additionalRestriction: actor.resolverPolicyRestriction,
    governedAction:
      current.kind === "request_confirmation"
      && current.payload !== null
      && typeof current.payload === "object"
      && (
        ("toolAction" in current.payload && current.payload.toolAction !== undefined)
        || ("secretProposal" in current.payload && current.payload.secretProposal !== undefined)
      ),
  });
}

type IssueResolutionContext = {
  id: string;
  companyId: string;
  status: string;
  workMode: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  reviewPolicy: IssueReviewPolicy | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
};

async function assertRequestConfirmationResolutionAllowedUnderLock(
  tx: Db,
  issue: IssueResolutionContext,
  interaction: IssueThreadInteractionRow,
  actor: InteractionActor,
) {
  if (isTerminalIssueStatus(issue.status)) {
    throw conflict("Interaction is no longer actionable because the issue is closed");
  }

  const isReviewVerdict = issue.status === "in_review"
    && isRequestConfirmationLikeKind(interaction.kind)
    && await isIssueReviewVerdictInteraction(tx, { issue, interaction });

  assertInteractionResolutionAllowed(interaction, actor);
  if (!isReviewVerdict) return;

  const verdictActor = actor.agentId
    ? { type: "agent" as const, id: actor.agentId }
    : actor.userId
      ? { type: "user" as const, id: actor.userId }
      : null;
  if (!verdictActor) {
    throw forbidden("A review verdict requires an authenticated agent or user");
  }
  await assertIssueReviewVerdictActorAllowed(tx, {
    issue,
    actor: verdictActor,
  });
}

const REQUEST_CONFIRMATION_INTERACTION_KINDS = [
  "request_confirmation",
  "request_checkbox_confirmation",
] as const;
type RequestConfirmationLikeKind = (typeof REQUEST_CONFIRMATION_INTERACTION_KINDS)[number];
type RequestConfirmationLikeInteraction =
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction;

const TARGET_BOUND_INTERACTION_KINDS = [
  ...REQUEST_CONFIRMATION_INTERACTION_KINDS,
  "request_item_verdicts",
] as const;
type TargetBoundInteractionKind = (typeof TARGET_BOUND_INTERACTION_KINDS)[number];
type TargetBoundInteraction =
  | RequestConfirmationLikeInteraction
  | RequestItemVerdictsInteraction;

const USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS = [
  ...TARGET_BOUND_INTERACTION_KINDS,
  "ask_user_questions",
  "connection_intent",
] as const;
type UserCommentSupersedableKind = (typeof USER_COMMENT_SUPERSEDABLE_INTERACTION_KINDS)[number];
type UserCommentSupersedableInteraction =
  | TargetBoundInteraction
  | AskUserQuestionsInteraction
  | ConnectionIntentInteraction;

function isRequestConfirmationLikeKind(kind: string): kind is RequestConfirmationLikeKind {
  return (REQUEST_CONFIRMATION_INTERACTION_KINDS as readonly string[]).includes(kind);
}

function isTargetBoundInteractionKind(kind: string): kind is TargetBoundInteractionKind {
  return (TARGET_BOUND_INTERACTION_KINDS as readonly string[]).includes(kind);
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
    && row.requestedResolverPolicy === input.resolverPolicy
    && (row.addresseeAgentId ?? null) === (input.addresseeAgentId ?? null)
    && (row.addresseeUserId ?? null) === (input.addresseeUserId ?? null)
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

/**
 * Parse a stored interaction `result` blob tolerantly. Rows persisted by older
 * builds can carry a `result` shape that predates the current schema — e.g. a
 * legacy `outcome` value ("withdrawn_by_creator") no longer in the enum.
 * `hydrateInteraction` runs over every row in `listForIssue`, so a hard
 * `.parse()` on one stale row throws and 500s the *entire* issue's interaction
 * list — which bricks both the web thread and plugin consumers such as the
 * Slack gateway's notifier/digest/aging loops (LOOA-629). Degrade an
 * unparseable `result` to `null` (the interaction still lists; a
 * resolved-but-unparseable result is treated as absent) instead of throwing.
 */
function parseStoredInteractionResult<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  row: Pick<IssueThreadInteractionRow, "id" | "kind">,
): z.infer<S> | null {
  if (raw == null) return null;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  console.warn(
    `[paperclip] Dropping unparseable ${row.kind} interaction result for interaction ${row.id}`,
    parsed.error.issues,
  );
  return null;
}

function hydrateInteraction(
  row: IssueThreadInteractionRow,
): IssueThreadInteraction {
  const storedRequestedResolverPolicy = row.requestedResolverPolicy as IssueThreadInteractionResolverPolicy;
  const storedEffectiveResolverPolicy = row.effectiveResolverPolicy as IssueThreadInteractionResolverPolicy;
  const resolverPolicyProvenance = row.resolverPolicyProvenance
    ?? (storedRequestedResolverPolicy === "board_only" || storedRequestedResolverPolicy === "board_or_agents"
      ? "legacy_inherited_restriction"
      : "inherited");
  const canonicalizeStoredPolicy = (
    policy: IssueThreadInteractionResolverPolicy,
  ): IssueThreadInteractionCanonicalResolverPolicy =>
    canonicalizeStoredResolverPolicy(policy, resolverPolicyProvenance);
  const requestedResolverPolicy = canonicalizeStoredPolicy(storedRequestedResolverPolicy);
  const effectiveResolverPolicy = canonicalizeStoredPolicy(storedEffectiveResolverPolicy);
  const base = {
    ...row,
    idempotencyKey: row.idempotencyKey ?? null,
    addresseeAgentId: row.addresseeAgentId ?? null,
    addresseeUserId: row.addresseeUserId ?? null,
    status: row.status as IssueThreadInteraction["status"],
    continuationPolicy: row.continuationPolicy as IssueThreadInteraction["continuationPolicy"],
    resolverPolicy: requestedResolverPolicy,
    requestedResolverPolicy,
    effectiveResolverPolicy,
    resolverPolicyProvenance,
    effectiveResolverPolicySource: row.effectiveResolverPolicySource ?? "requested",
    legacyResolverPolicyAliases: {
      requested: legacyIssueThreadInteractionResolverPolicyAlias(requestedResolverPolicy),
      effective: legacyIssueThreadInteractionResolverPolicyAlias(effectiveResolverPolicy),
    },
  };

  switch (row.kind) {
    case "suggest_tasks":
      return {
        ...base,
        kind: "suggest_tasks",
        payload: suggestTasksPayloadSchema.parse(row.payload),
        result: parseStoredInteractionResult(suggestTasksResultSchema, row.result, row),
      } satisfies SuggestTasksInteraction;
    case "ask_user_questions":
      return {
        ...base,
        kind: "ask_user_questions",
        payload: askUserQuestionsPayloadSchema.parse(row.payload),
        result: parseStoredInteractionResult(askUserQuestionsResultSchema, row.result, row),
      } satisfies AskUserQuestionsInteraction;
    case "request_confirmation":
      return {
        ...base,
        kind: "request_confirmation",
        payload: requestConfirmationPayloadSchema.parse(row.payload),
        result: parseStoredInteractionResult(requestConfirmationResultSchema, row.result, row),
      } satisfies RequestConfirmationInteraction;
    case "request_checkbox_confirmation":
      return {
        ...base,
        kind: "request_checkbox_confirmation",
        payload: requestCheckboxConfirmationPayloadSchema.parse(row.payload),
        result: parseStoredInteractionResult(requestCheckboxConfirmationResultSchema, row.result, row),
      } satisfies RequestCheckboxConfirmationInteraction;
    case "request_item_verdicts":
      return {
        ...base,
        kind: "request_item_verdicts",
        payload: requestItemVerdictsPayloadSchema.parse(row.payload),
        result: parseStoredInteractionResult(requestItemVerdictsResultSchema, row.result, row),
      } satisfies RequestItemVerdictsInteraction;
    case "connection_intent":
      return {
        ...base,
        kind: "connection_intent",
        payload: connectionIntentPayloadSchema.parse(row.payload),
        result: parseStoredInteractionResult(connectionIntentResultSchema, row.result, row),
      } satisfies ConnectionIntentInteraction;
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

function interactionNotFoundError() {
  return notFound("Interaction not found", { code: "interaction_not_found" });
}

function interactionIssueClosedError() {
  return issueThreadInteractionResolutionError(
    409,
    "interaction_issue_closed",
    "Interaction is no longer actionable because the issue is closed",
  );
}

function interactionAlreadyResolvedError() {
  return issueThreadInteractionResolutionError(
    409,
    "interaction_already_resolved",
    "Interaction has already been resolved",
  );
}

function interactionTerminalError(row: { status: string; result?: unknown }) {
  const result = row.result && typeof row.result === "object" && !Array.isArray(row.result)
    ? row.result as unknown as Record<string, unknown>
    : null;
  if (result?.outcome === "stale_target") {
    return issueThreadInteractionResolutionError(
      409,
      "interaction_stale_target",
      "Interaction target is stale",
    );
  }
  if (result?.outcome === "superseded_by_comment" || result?.outcome === "superseded_by_newer_request") {
    return issueThreadInteractionResolutionError(
      409,
      "interaction_superseded",
      "Interaction has been superseded",
    );
  }
  if (result?.outcome === "issue_closed") return interactionIssueClosedError();
  return issueThreadInteractionResolutionError(
    409,
    "interaction_already_resolved",
    "Interaction has already been resolved",
  );
}

function shouldReturnAcceptedConfirmationToCreatorAgent(args: {
  issue: IssueResolutionContext;
  current: IssueThreadInteractionRow;
  actor: InteractionActor;
}) {
  if (!isRequestConfirmationLikeKind(args.current.kind)) return false;
  if (!args.current.createdByAgentId) return false;
  if (!args.actor.userId) return false;
  if (isTerminalIssueStatus(args.issue.status)) return false;
  if (args.issue.assigneeAgentId) {
    return args.issue.status === "in_review"
      && args.issue.assigneeAgentId === args.current.createdByAgentId;
  }
  return Boolean(args.issue.assigneeUserId);
}

function shouldSupersedeInteractionOnUserComment(interaction: UserCommentSupersedableInteraction) {
  if (interaction.kind === "connection_intent") return true;
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
    case "request_item_verdicts":
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
  if (row.kind === "connection_intent") {
    return {
      version: 1,
      outcome: "expired",
      reason: "Superseded by a newer user comment",
    } as const;
  }
  if (row.kind === "ask_user_questions") {
    return {
      version: 1,
      answers: [],
      expirationReason: "superseded_by_comment",
      commentId,
      summaryMarkdown: null,
    } as const;
  }

  if (row.kind === "request_item_verdicts") {
    const interaction = hydrateInteraction(row) as RequestItemVerdictsInteraction;
    return {
      version: 1,
      outcome: "superseded_by_comment",
      complete: false,
      items: interaction.result?.items ?? [],
      commentId,
    } satisfies RequestItemVerdictsResult;
  }

  return {
    version: 1,
    outcome: "superseded_by_comment",
    commentId,
  } as const;
}

function buildStaleTargetResult(
  row: IssueThreadInteractionRow,
  staleTarget: RequestConfirmationTarget | null,
) {
  if (row.kind === "request_item_verdicts") {
    const interaction = hydrateInteraction(row) as RequestItemVerdictsInteraction;
    return {
      version: 1,
      outcome: "stale_target",
      complete: false,
      items: interaction.result?.items ?? [],
      staleTarget,
    } satisfies RequestItemVerdictsResult;
  }

  return {
    version: 1,
    outcome: "stale_target",
    staleTarget,
  } as const;
}

function buildSupersededByNewerRequestResult(replacementInteractionId: string) {
  return {
    version: 1,
    outcome: "superseded_by_newer_request",
    supersededByInteractionId: replacementInteractionId,
  } as const;
}

// An agent that posts a fresh ask_user_questions while its own earlier ones on
// the same issue are still pending has replaced them — the newer card carries
// the real ask, so the stale siblings auto-expire (PAP-437). Mirrors the
// `superseded_by_comment` shape (ask_user_questions results key expiry off
// `expirationReason`, not `outcome`) so the UI can hide them cleanly.
function buildSupersededByNewerInteractionResult(replacementInteractionId: string) {
  return {
    version: 1,
    answers: [],
    expirationReason: "superseded_by_newer_interaction",
    supersededByInteractionId: replacementInteractionId,
    summaryMarkdown: null,
  } as const;
}

function buildAdministrativeOutcomeResult(
  row: IssueThreadInteractionRow,
  outcome: "withdrawn" | "issue_closed" | "addressee_deleted",
  reason: string | null = null,
) {
  if (row.kind === "connection_intent") {
    return { version: 1, outcome: "expired", reason } as const;
  }
  if (row.kind === "ask_user_questions") {
    return { version: 1, outcome, reason, answers: [], summaryMarkdown: null } as const;
  }
  if (row.kind === "request_item_verdicts") {
    const interaction = hydrateInteraction(row) as RequestItemVerdictsInteraction;
    return {
      version: 1,
      outcome,
      reason,
      complete: false,
      items: interaction.result?.items ?? [],
    } satisfies RequestItemVerdictsResult;
  }
  return {
    version: 1,
    outcome,
    reason,
    ...(linkedSecretProposalId(row)
      ? {
          secretProposal: {
            version: 1,
            status: outcome === "withdrawn" ? "withdrawn" : "expired",
            updatedAt: new Date().toISOString(),
          },
        }
      : {}),
  } as const;
}

function buildSkippedOutcomeResult(
  row: IssueThreadInteractionRow,
  reason: string | null,
) {
  if (row.kind === "ask_user_questions") {
    return {
      version: 1,
      outcome: "skipped",
      reason,
      answers: [],
      cancelled: true,
      cancellationReason: reason,
      summaryMarkdown: null,
    } as const;
  }
  if (row.kind === "request_item_verdicts") {
    const interaction = hydrateInteraction(row) as RequestItemVerdictsInteraction;
    return {
      version: 1,
      outcome: "skipped",
      reason,
      complete: false,
      items: interaction.result?.items ?? [],
    } satisfies RequestItemVerdictsResult;
  }
  if (row.kind === "suggest_tasks") {
    return {
      version: 1,
      outcome: "skipped",
      reason,
      createdTasks: [],
      skippedClientKeys: [],
    } as const;
  }
  return { version: 1, outcome: "skipped", reason } as const;
}

// Rollback sentinel: the interaction was resolved by another actor between the
// pending-rows read and the conditional update, so the enclosing transaction's
// tool-action revocation must be undone.
class InteractionResolvedConcurrentlyError extends Error {
  constructor() {
    super("Interaction was resolved concurrently");
  }
}

// A request_confirmation card can govern a parked tool call via a linked
// tool_action_requests row. Administrative resolutions (withdraw, terminal-issue
// expiry) must settle that row too, or the parked call stays approvable under
// its own one-hour lifecycle after its card is gone.
async function resolveLinkedToolActionRequests(
  db: Pick<Db, "update">,
  interaction: Pick<IssueThreadInteractionRow, "id" | "companyId" | "kind">,
  outcome: {
    status: "expired" | "cancelled";
    fromStatuses: Array<"pending" | "approved">;
    actor: InteractionActor;
    now: Date;
  },
) {
  if (interaction.kind !== "request_confirmation") return;
  await db
    .update(toolActionRequests)
    .set({
      status: outcome.status,
      resolvedByAgentId: outcome.actor.agentId ?? null,
      resolvedByUserId: outcome.actor.userId ?? null,
      resolvedAt: outcome.now,
      updatedAt: outcome.now,
    })
    .where(and(
      eq(toolActionRequests.companyId, interaction.companyId),
      eq(toolActionRequests.interactionId, interaction.id),
      inArray(toolActionRequests.status, outcome.fromStatuses),
    ));
}

function linkedSecretProposalId(interaction: Pick<IssueThreadInteractionRow, "kind" | "payload">) {
  if (interaction.kind !== "request_confirmation") return null;
  const payload = interaction.payload && typeof interaction.payload === "object" && !Array.isArray(interaction.payload)
    ? interaction.payload as unknown as Record<string, unknown>
    : null;
  const secretProposal = payload?.secretProposal && typeof payload.secretProposal === "object" && !Array.isArray(payload.secretProposal)
    ? payload.secretProposal as Record<string, unknown>
    : null;
  return typeof secretProposal?.proposalId === "string" ? secretProposal.proposalId : null;
}

async function lockLinkedSecretProposal(
  db: Db,
  interaction: Pick<IssueThreadInteractionRow, "id" | "companyId" | "kind" | "payload">,
) {
  const proposalId = linkedSecretProposalId(interaction);
  if (!proposalId) return;
  await db
    .select({ id: companySecretProposals.id })
    .from(companySecretProposals)
    .where(and(
      eq(companySecretProposals.id, proposalId),
      eq(companySecretProposals.companyId, interaction.companyId),
      eq(companySecretProposals.interactionId, interaction.id),
    ))
    .for("update");
}

async function resolveLinkedSecretProposal(
  db: Db,
  interaction: Pick<IssueThreadInteractionRow, "id" | "companyId" | "kind" | "payload">,
  outcome: {
    status: "rejected" | "withdrawn" | "expired";
    actor: InteractionActor;
    reason?: string | null;
    now: Date;
  },
) {
  const proposalId = linkedSecretProposalId(interaction);
  if (!proposalId) return;
  const [proposal] = await db
    .update(companySecretProposals)
    .set({
      status: outcome.status,
      resolvedByUserId: outcome.actor.userId ?? null,
      resolvedAt: outcome.now,
      resolutionReason: outcome.reason ?? null,
      valueCiphertext: null,
      ciphertextScrubbedAt: outcome.now,
      updatedAt: outcome.now,
    })
    .where(and(
      eq(companySecretProposals.id, proposalId),
      eq(companySecretProposals.companyId, interaction.companyId),
      eq(companySecretProposals.interactionId, interaction.id),
      eq(companySecretProposals.status, "pending"),
    ))
    .returning();
  if (!proposal) throw conflict("Linked secret proposal is no longer pending");
  const actorType = outcome.actor.userId ? "user" as const : outcome.actor.agentId ? "agent" as const : "system" as const;
  const actorId = outcome.actor.userId ?? outcome.actor.agentId ?? outcome.actor.systemId ?? "system";
  await logActivity(db, {
    companyId: interaction.companyId,
    actorType,
    actorId,
    action: `secret.proposal.${outcome.status}`,
    entityType: "company_secret_proposal",
    entityId: proposal.id,
    agentId: proposal.proposedByAgentId,
    runId: proposal.originRunId,
    details: {
      ciphertextScrubbed: true,
      issueId: proposal.originIssueId,
      interactionId: interaction.id,
      reason: outcome.reason ?? null,
    },
  });
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
  switch (interaction.kind) {
    case "request_confirmation":
    case "request_checkbox_confirmation":
    case "request_item_verdicts":
      return interaction.payload.target?.type ?? "none";
    default:
      return "none";
  }
}

function deriveResolutionReason(interaction: IssueThreadInteraction) {
  switch (interaction.status) {
    case "accepted":
      return "accepted";
    case "rejected":
      return "rejected";
    case "cancelled":
      if (interaction.result && "outcome" in interaction.result && interaction.result.outcome === "skipped") {
        return "skipped";
      }
      return "cancelled";
    case "expired": {
      if (interaction.kind === "connection_intent") {
        return interaction.result?.outcome ?? "expired";
      }
      if (interaction.kind === "ask_user_questions") {
        return interaction.result?.expirationReason ?? "expired";
      }
      if (interaction.kind === "request_confirmation" || interaction.kind === "request_checkbox_confirmation") {
        return interaction.result?.outcome ?? "expired";
      }
      if (interaction.kind === "request_item_verdicts") {
        return interaction.result?.outcome ?? "expired";
      }
      return "expired";
    }
    case "answered": {
      if (interaction.kind === "request_item_verdicts") {
        return interaction.result?.outcome ?? "answered";
      }
      return "answered";
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
    case "request_item_verdicts":
      return {
        itemCount: nonNegativeInteger(interaction.payload.items.length),
        resolvedItemCount: nonNegativeInteger(interaction.result?.items?.length ?? 0),
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
      interactionKind: interaction.kind === "connection_intent" ? "other" : interaction.kind,
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
      legacyInheritedRestriction:
        interaction.resolverPolicyProvenance === "legacy_inherited_restriction",
    });
  } catch (error) {
    console.error("[paperclip] Failed to emit interaction.resolved telemetry", error);
  }
}

function emitInteractionCreatedTelemetry(args: {
  interactionKind: IssueThreadInteractionKind;
  usedDeprecatedResolverPolicyAlias: boolean;
}) {
  const telemetryClient = getTelemetryClient();
  if (!telemetryClient) return;

  try {
    trackInteractionCreated(telemetryClient, {
      ...args,
      interactionKind: args.interactionKind === "connection_intent" ? "other" : args.interactionKind,
    });
  } catch (error) {
    console.error("[paperclip] Failed to emit interaction.created telemetry", error);
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

export function resolveSelectedSuggestedTasks(args: {
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

function resolveRequestItemVerdictSubmissions(args: {
  interaction: RequestItemVerdictsInteraction;
  input: SubmitIssueThreadInteractionVerdicts;
  actor: InteractionActor;
  now: Date;
}) {
  const existingItems = args.interaction.result?.items ?? [];
  const existingById = new Map(existingItems.map((item) => [item.id, item] as const));
  const payloadItemIds = new Set(args.interaction.payload.items.map((item) => item.id));
  const enabledVerdicts = new Set(args.interaction.payload.verdicts ?? ["approve", "reject"]);
  const requireReasonOn = new Set(args.interaction.payload.requireReasonOn ?? ["reject"]);
  const newlyResolvedById = new Map<string, RequestItemVerdictsResultItem>();
  const newlyResolvedItemIds: string[] = [];

  for (const submitted of args.input.verdicts) {
    if (!payloadItemIds.has(submitted.id)) {
      throw unprocessable(`Unknown item verdict id: ${submitted.id}`);
    }
    if (existingById.has(submitted.id)) {
      continue;
    }
    if (!enabledVerdicts.has(submitted.verdict)) {
      throw unprocessable(`Verdict ${submitted.verdict} is not enabled for this item verdict request`);
    }

    const reason = submitted.reason?.trim() ?? "";
    if (requireReasonOn.has(submitted.verdict) && reason.length === 0) {
      throw unprocessable(`A reason is required when verdict is ${submitted.verdict}`);
    }

    if (newlyResolvedById.has(submitted.id)) {
      continue;
    }
    newlyResolvedById.set(submitted.id, {
      id: submitted.id,
      verdict: submitted.verdict,
      ...(reason ? { reason } : {}),
      ...(args.actor.userId ? { resolvedByUserId: args.actor.userId } : {}),
      ...(args.actor.agentId ? { resolvedByAgentId: args.actor.agentId } : {}),
      ...(args.actor.runId ? { resolvedByRunId: args.actor.runId } : {}),
      resolvedAt: args.now,
    });
    newlyResolvedItemIds.push(submitted.id);
  }

  const nextById = new Map<string, RequestItemVerdictsResultItem>(existingItems.map((item) => [item.id, item]));
  for (const [id, item] of newlyResolvedById) {
    nextById.set(id, item);
  }
  const items = args.interaction.payload.items
    .map((item) => nextById.get(item.id))
    .filter((item): item is RequestItemVerdictsResultItem => Boolean(item));

  return {
    items,
    complete: items.length === args.interaction.payload.items.length,
    newlyResolvedItemIds,
  };
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
  // When true, take a FOR UPDATE row lock on the joined document so a concurrent
  // revision publish (which updates documents.latestRevisionId) must serialize
  // behind the caller's transaction. Only meaningful inside a transaction.
  lockForUpdate?: boolean;
}) {
  if (args.target.type !== "issue_document") return null;
  const targetIssueId = args.target.issueId ?? args.issueId;
  const query = db
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
    ));
  const row = await (args.lockForUpdate ? query.for("update", { of: documents }) : query)
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
  // Forwarded to getIssueDocumentTargetSnapshot; pass true when validating
  // inside the create transaction so the revision read locks the document row
  // and stays atomic with the interaction insert.
  lockForUpdate?: boolean;
}) {
  if (!args.target) return;
  if (args.target.type !== "issue_document") return;
  const snapshot = await getIssueDocumentTargetSnapshot(db, {
    companyId: args.companyId,
    issueId: args.issueId,
    target: args.target,
    lockForUpdate: args.lockForUpdate,
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
  if (!isTargetBoundInteractionKind(args.row.kind) || args.row.status !== "pending") return null;
  const interaction = hydrateInteraction(args.row) as TargetBoundInteraction;
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
        ...buildStaleTargetResult(args.row, target),
      },
      resolvedByAgentId: args.actor.agentId ?? null,
      resolvedByRunId: args.actor.runId ?? null,
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
    throw issueThreadInteractionResolutionError(
      409,
      "interaction_already_resolved",
      "Interaction has already been resolved",
    );
  }
  await touchIssue(db, args.row.issueId);
  const expired = hydrateInteraction(updated);
  await emitInteractionResolvedTelemetry(db, expired);
  return expired;
}

export function issueThreadInteractionService(db: Db, opts: IssueThreadInteractionServiceOptions = {}) {
  const pullRequestStateCache = new Map<string, { state: PullRequestMergeState; checkedAt: number }>();
  const now = opts.now ?? (() => new Date());
  const defaultPullRequestStateResolver = opts.resolvePullRequestState
    ? null
    : createPullRequestMergeStateResolver(db);

  async function resolvePullRequestState(
    companyId: string,
    reference: GitHubPullRequestReference,
  ): Promise<PullRequestMergeState> {
    if (opts.resolvePullRequestState) return opts.resolvePullRequestState(companyId, reference);
    return defaultPullRequestStateResolver?.(companyId, reference) ?? "unknown";
  }

  async function resolvePullRequestStates(
    entries: Array<{ key: string; companyId: string; reference: GitHubPullRequestReference }>,
  ) {
    const states = new Map<string, PullRequestMergeState>();
    const pending = entries.slice();
    const workerCount = Math.min(8, pending.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (pending.length > 0) {
        const entry = pending.shift();
        if (!entry) return;
        const state = await resolvePullRequestState(entry.companyId, entry.reference);
        states.set(entry.key, state);
      }
    }));
    return states;
  }
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

  async function getForIssue(issue: { id: string; companyId: string }, interactionId: string) {
    const current = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, interactionId))
      .then((rows) => rows[0] ?? null);
    if (!current || current.companyId !== issue.companyId || current.issueId !== issue.id) {
      throw interactionNotFoundError();
    }
    return hydrateInteraction(current);
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

    // Block only while the source run's worktree sync-back is genuinely still
    // pending or in flight. A finalize that reached a terminal outcome — including
    // a `failed` sync-back or a stale `running` record left by an ended run — is
    // treated as settled by `runWorkspaceIsFinalized`, so a dead run can no longer
    // wedge this confirmation forever.
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
    issue: { id: string; companyId: string; status?: string };
    interactionId: string;
  }) {
    const current = await db
      .select()
      .from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, args.interactionId))
      .then((rows) => rows[0] ?? null);

    if (!current) throw interactionNotFoundError();
    if (current.companyId !== args.issue.companyId || current.issueId !== args.issue.id) {
      throw interactionNotFoundError();
    }
    if (args.issue.status && isTerminalIssueStatus(args.issue.status)) {
      throw interactionIssueClosedError();
    }
    if (current.status !== "pending") {
      throw interactionTerminalError(current);
    }
    return current;
  }

  function assertIssueOpenForInteractionResolution(issue: { id: string; companyId: string; status?: string }) {
    if (issue.status && isTerminalIssueStatus(issue.status)) {
      throw interactionIssueClosedError();
    }
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
    if (expired) throw interactionTerminalError({ status: expired.status, result: expired.result });

    const now = new Date();
    const postCommitActivityPublications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      // Policy mutations and review transitions use the same issue-row lock,
      // so the authoritative review policy and requester are stable through
      // the verdict write. Terminal issue transitions also lock the issue
      // before expiring linked proposals, so keep issue -> proposal ->
      // interaction as the shared lifecycle order.
      const issueContext = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          workMode: issues.workMode,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          reviewPolicy: issues.reviewPolicy,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
        })
        .from(issues)
        .where(eq(issues.id, args.issue.id))
        .for("update")
        .then((rows: IssueResolutionContext[]) => rows[0] ?? null);

      if (!issueContext || issueContext.companyId !== args.issue.companyId) {
        throw notFound("Issue not found");
      }

      await lockLinkedSecretProposal(tx as unknown as Db, args.current);

      const lockedCurrent = await tx
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, args.current.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !lockedCurrent
        || lockedCurrent.companyId !== args.issue.companyId
        || lockedCurrent.issueId !== args.issue.id
      ) {
        throw notFound("Interaction not found");
      }
      if (lockedCurrent.status !== "pending") {
        throw issueThreadInteractionResolutionError(
          409,
          "interaction_already_resolved",
          "Interaction has already been resolved",
        );
      }
      await assertRequestConfirmationResolutionAllowedUnderLock(
        tx as unknown as Db,
        issueContext,
        lockedCurrent,
        args.actor,
      );

      const interaction = hydrateInteraction(lockedCurrent);
      const selectedOptionIds = interaction.kind === "request_checkbox_confirmation"
        ? resolveSelectedCheckboxConfirmationOptions({
            interaction,
            selectedOptionIds: args.input.selectedOptionIds,
          })
        : undefined;

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
          resolvedByRunId: args.actor.runId ?? null,
          resolvedByUserId: args.actor.userId ?? null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(issueThreadInteractions.id, lockedCurrent.id),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!updated) {
        throw issueThreadInteractionResolutionError(
          409,
          "interaction_already_resolved",
          "Interaction has already been resolved",
        );
      }

      let continuationIssue: IssueWakeTarget | null = null;
      const acceptedPlanTarget = readAcceptedPlanConfirmationTarget(
        lockedCurrent.payload,
        issueContext.id,
      );
      const acceptedPlanStartsExecution =
        lockedCurrent.kind === "request_confirmation"
        && acceptedPlanTarget?.issueId === issueContext.id
        && acceptedPlanTarget.key === "plan"
        && issueContext.workMode === "planning";
      if (isNativeCompletionReview(lockedCurrent)) {
        const completedIssue = await issueService(db).update(args.issue.id, {
          status: "done",
          actorAgentId: args.actor.agentId ?? null,
          actorUserId: args.actor.userId ?? null,
        }, tx, postCommitActivityPublications);
        if (completedIssue) {
          continuationIssue = {
            id: completedIssue.id,
            assigneeAgentId: completedIssue.assigneeAgentId ?? null,
            assigneeUserId: completedIssue.assigneeUserId ?? null,
            status: completedIssue.status,
          };
        }
      } else if (shouldReturnAcceptedConfirmationToCreatorAgent({
        issue: issueContext,
        current: lockedCurrent,
        actor: args.actor,
      })) {
        const returnStatus = issueContext.status === "blocked" ? "blocked" : "todo";
        const returnedIssue = await issueService(db).update(args.issue.id, {
          status: returnStatus,
          ...(acceptedPlanStartsExecution ? { workMode: "standard" } : {}),
          assigneeAgentId: lockedCurrent.createdByAgentId,
          assigneeUserId: null,
          actorAgentId: args.actor.agentId ?? null,
          actorUserId: args.actor.userId ?? null,
        }, tx, postCommitActivityPublications);

        if (returnedIssue) {
          continuationIssue = {
            id: returnedIssue.id,
            assigneeAgentId: returnedIssue.assigneeAgentId ?? null,
            assigneeUserId: returnedIssue.assigneeUserId ?? null,
            status: returnedIssue.status,
            ...(acceptedPlanStartsExecution ? { workMode: returnedIssue.workMode } : {}),
          };
        }
      } else if (acceptedPlanStartsExecution) {
        const executionIssue = await issueService(db).update(args.issue.id, {
          workMode: "standard",
          actorAgentId: args.actor.agentId ?? null,
          actorUserId: args.actor.userId ?? null,
        }, tx, postCommitActivityPublications);
        if (executionIssue) {
          continuationIssue = {
            id: executionIssue.id,
            assigneeAgentId: executionIssue.assigneeAgentId ?? null,
            assigneeUserId: executionIssue.assigneeUserId ?? null,
            status: executionIssue.status,
            workMode: executionIssue.workMode,
          };
        }
      } else {
        await touchIssue(tx, args.issue.id);
      }

      if (args.actor.systemId) {
        await logActivity(tx as unknown as Db, {
          companyId: args.issue.companyId,
          actorType: "system",
          actorId: args.actor.systemId,
          agentId: null,
          runId: null,
          action: "issue.thread_interaction_accepted",
          entityType: "issue",
          entityId: args.issue.id,
          details: {
            interactionId: lockedCurrent.id,
            interactionKind: lockedCurrent.kind,
            interactionStatus: "accepted",
            resolutionActorKind: "system",
            requestedResolverPolicy: lockedCurrent.requestedResolverPolicy,
            effectiveResolverPolicy: lockedCurrent.effectiveResolverPolicy,
            ...(args.actor.resolutionDetails ?? {}),
          },
        });
      }

      return {
        interaction: hydrateInteraction(updated),
        continuationIssue,
      };
    });
    for (const publication of postCommitActivityPublications) publishActivity(publication);
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
    if (expired) throw interactionTerminalError({ status: expired.status, result: expired.result });

    const interaction = hydrateInteraction(args.current) as RequestConfirmationLikeInteraction;
    const reason = args.input.reason?.trim() ?? "";
    if (interaction.payload.rejectRequiresReason === true && reason.length === 0) {
      throw unprocessable("A decline reason is required for this confirmation");
    }

    const now = new Date();
    const updated = await db.transaction(async (tx) => {
      const issueContext = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          workMode: issues.workMode,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          reviewPolicy: issues.reviewPolicy,
          createdByAgentId: issues.createdByAgentId,
          createdByUserId: issues.createdByUserId,
        })
        .from(issues)
        .where(eq(issues.id, args.issue.id))
        .for("update")
        .then((rows: IssueResolutionContext[]) => rows[0] ?? null);
      if (!issueContext || issueContext.companyId !== args.issue.companyId) {
        throw notFound("Issue not found");
      }

      // Terminal issue transitions expire linked proposals while holding this
      // issue row. Match their issue -> proposal -> interaction order so a
      // close/cancel race cannot invert the first two locks.
      await lockLinkedSecretProposal(tx as unknown as Db, args.current);

      const lockedCurrent = await tx
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, args.current.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !lockedCurrent
        || lockedCurrent.companyId !== args.issue.companyId
        || lockedCurrent.issueId !== args.issue.id
      ) {
        throw notFound("Interaction not found");
      }
      if (lockedCurrent.status !== "pending") {
        throw issueThreadInteractionResolutionError(
          409,
          "interaction_already_resolved",
          "Interaction has already been resolved",
        );
      }
      await assertRequestConfirmationResolutionAllowedUnderLock(
        tx as unknown as Db,
        issueContext,
        lockedCurrent,
        args.actor,
      );

      await resolveLinkedSecretProposal(tx as unknown as Db, lockedCurrent, {
        status: "rejected",
        actor: args.actor,
        reason: reason || null,
        now,
      });

      const [resolved] = await tx
        .update(issueThreadInteractions)
        .set({
          status: "rejected",
          result: {
            version: 1,
            outcome: "rejected",
            reason: reason || null,
            ...(linkedSecretProposalId(lockedCurrent)
              ? { secretProposal: { version: 1, status: "rejected", updatedAt: now.toISOString() } }
              : {}),
          },
          resolvedByAgentId: args.actor.agentId ?? null,
          resolvedByRunId: args.actor.runId ?? null,
          resolvedByUserId: args.actor.userId ?? null,
          resolvedAt: now,
          updatedAt: now,
        })
        .where(and(
          eq(issueThreadInteractions.id, lockedCurrent.id),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();

      if (!resolved) {
        throw issueThreadInteractionResolutionError(
          409,
          "interaction_already_resolved",
          "Interaction has already been resolved",
        );
      }
      if (isNativeCompletionReview(lockedCurrent)) {
        await issueService(db).update(args.issue.id, {
          status: "todo",
          assigneeAgentId: issueContext.assigneeAgentId,
          assigneeUserId: null,
          actorAgentId: args.actor.agentId ?? null,
          actorUserId: args.actor.userId ?? null,
        }, tx);
      } else {
        await touchIssue(tx, args.issue.id);
      }
      return resolved;
    });

    const rejected = hydrateInteraction(updated);
    await emitInteractionResolvedTelemetry(db, rejected);
    return rejected;
  }

  return {
    getForIssue,
    createConnectionIntent: async (
      issue: { id: string; companyId: string },
      input: {
        payload: ConnectionIntentInteraction["payload"];
        sourceRunId: string;
        addresseeUserId: string;
        idempotencyKey: string;
      },
    ) => {
      const payload = connectionIntentPayloadSchema.parse(input.payload);
      const existing = await getIdempotentInteraction({
        issueId: issue.id,
        companyId: issue.companyId,
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) {
        if (
          existing.kind !== "connection_intent"
          || existing.sourceRunId !== input.sourceRunId
          || existing.addresseeUserId !== input.addresseeUserId
          || !isDeepStrictEqual(existing.payload, payload)
        ) {
          throw conflict("Interaction idempotency key already exists for a different request", {
            idempotencyKey: input.idempotencyKey,
          });
        }
        return hydrateInteraction(existing) as ConnectionIntentInteraction;
      }

      const created = await db.transaction(async (tx) => {
        const issueRow = await tx
          .select({ status: issues.status })
          .from(issues)
          .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!issueRow || isTerminalIssueStatus(issueRow.status)) {
          throw conflict("Cannot create an interaction on a closed issue");
        }

        const [row] = await tx
          .insert(issueThreadInteractions)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            kind: "connection_intent",
            status: "pending",
            continuationPolicy: "wake_assignee",
            requestedResolverPolicy: "human_only",
            effectiveResolverPolicy: "human_only",
            resolverPolicyProvenance: "explicit",
            effectiveResolverPolicySource: "governed_action",
            idempotencyKey: input.idempotencyKey,
            sourceRunId: input.sourceRunId,
            title: `Connect ${payload.serviceName}`,
            summary: `${payload.requestingAgentName} needs this connection to continue.`,
            createdByAgentId: payload.requestingAgentId,
            addresseeUserId: input.addresseeUserId,
            payload,
          })
          .returning();

        const olderPending = await tx
          .select()
          .from(issueThreadInteractions)
          .where(and(
            eq(issueThreadInteractions.companyId, issue.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
            eq(issueThreadInteractions.kind, "connection_intent"),
            eq(issueThreadInteractions.createdByAgentId, payload.requestingAgentId),
            eq(issueThreadInteractions.status, "pending"),
            ne(issueThreadInteractions.id, row.id),
          ));
        const supersededIds = olderPending
          .filter((candidate) => {
            const candidatePayload = connectionIntentPayloadSchema.safeParse(candidate.payload);
            return candidatePayload.success && candidatePayload.data.serviceSlug === payload.serviceSlug;
          })
          .map((candidate) => candidate.id);
        if (supersededIds.length > 0) {
          await tx
            .delete(toolOauthStates)
            .where(inArray(toolOauthStates.interactionId, supersededIds));
          await tx
            .update(issueThreadInteractions)
            .set({
              status: "expired",
              result: {
                version: 1,
                outcome: "superseded",
                supersededByInteractionId: row.id,
              },
              resolvedAt: now(),
              updatedAt: now(),
            })
            .where(inArray(issueThreadInteractions.id, supersededIds));
        }
        await touchIssue(tx, issue.id);
        return row;
      });

      const interaction = hydrateInteraction(created) as ConnectionIntentInteraction;
      emitInteractionCreatedTelemetry({
        interactionKind: "connection_intent",
        usedDeprecatedResolverPolicyAlias: false,
      });
      return interaction;
    },
    updateConnectionIntentPhase: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      phase: ConnectionIntentInteraction["payload"]["phase"],
      actor: InteractionActor,
    ) => {
      const current = await getPendingInteractionForResolution({ issue, interactionId });
      if (current.kind !== "connection_intent") {
        throw unprocessable("Only connection_intent interactions have a connection phase");
      }
      assertInteractionResolutionAllowed(current, actor);
      const payload = connectionIntentPayloadSchema.parse(current.payload);
      const [updated] = await db
        .update(issueThreadInteractions)
        .set({ payload: { ...payload, phase }, updatedAt: now() })
        .where(and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();
      if (!updated) throw interactionAlreadyResolvedError();
      await touchIssue(db, issue.id);
      return hydrateInteraction(updated) as ConnectionIntentInteraction;
    },
    resolveConnectionIntent: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      resultInput: ConnectionIntentInteraction["result"] extends infer T ? NonNullable<T> : never,
      actor: InteractionActor,
    ) => {
      const result = connectionIntentResultSchema.parse(resultInput);
      const current = await getPendingInteractionForResolution({ issue, interactionId });
      if (current.kind !== "connection_intent") {
        throw unprocessable("Only connection_intent interactions can be resolved by this operation");
      }
      if (!actor.userId) throw forbidden("Connection intents require a human resolver");
      assertInteractionResolutionAllowed(current, actor);
      const status = result.outcome === "connected"
        ? "accepted"
        : result.outcome === "declined"
          ? "rejected"
          : "expired";
      const resolvedAt = now();
      const [updated] = await db
        .update(issueThreadInteractions)
        .set({
          status,
          result,
          resolvedByUserId: actor.userId,
          resolvedAt,
          updatedAt: resolvedAt,
        })
        .where(and(
          eq(issueThreadInteractions.id, interactionId),
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .returning();
      if (!updated) throw interactionAlreadyResolvedError();
      await touchIssue(db, issue.id);
      const interaction = hydrateInteraction(updated) as ConnectionIntentInteraction;
      await emitInteractionResolvedTelemetry(db, interaction);
      return interaction;
    },
    sweepMergedPullRequestConfirmations: async (mergedHints: Array<{
      companyId: string;
      owner: string;
      repo: string;
      number: number;
    }> = []) => {
      const rows = await db
        .select({
          interaction: issueThreadInteractions,
          issue: {
            id: issues.id,
            companyId: issues.companyId,
            projectId: issues.projectId,
            goalId: issues.goalId,
            status: issues.status,
            assigneeAgentId: issues.assigneeAgentId,
          },
        })
        .from(issueThreadInteractions)
        .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
        .where(and(
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending"),
        ));

      const candidates = rows.flatMap((row) => {
        const references = getMergeConfirmationPullRequestReferences(row.interaction);
        return references.length > 0 ? [{ ...row, references }] : [];
      });
      if (candidates.length === 0) {
        return { checked: rows.length, candidates: 0, accepted: 0, woken: 0 };
      }

      const candidateIds = candidates.map(({ interaction }) => interaction.id);
      const linkedToolActions = await db
        .select({ interactionId: toolActionRequests.interactionId })
        .from(toolActionRequests)
        .where(inArray(toolActionRequests.interactionId, candidateIds));
      const toolActionInteractionIds = new Set(linkedToolActions
        .map((row) => row.interactionId)
        .filter((value): value is string => Boolean(value)));
      const eligible = candidates.filter(({ interaction }) => !toolActionInteractionIds.has(interaction.id));

      const checkedAt = now().getTime();
      const cacheTtlMs = opts.pullRequestCacheTtlMs ?? 5 * 60 * 1000;
      for (const hint of mergedHints) {
        const key = `${hint.companyId}:${hint.owner.toLowerCase()}/${hint.repo.toLowerCase()}#${hint.number}`;
        setBoundedPullRequestCacheEntry(pullRequestStateCache, key, { state: "merged", checkedAt });
      }
      const uniqueReferences = new Map<string, {
        key: string;
        companyId: string;
        reference: GitHubPullRequestReference;
      }>();
      for (const candidate of eligible) {
        for (const reference of candidate.references) {
          const key = `${candidate.issue.companyId}:${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
          const cached = pullRequestStateCache.get(key);
          if (cached && checkedAt - cached.checkedAt < cacheTtlMs) continue;
          uniqueReferences.set(key, { key, companyId: candidate.issue.companyId, reference });
        }
      }

      const refreshedStates = await resolvePullRequestStates([...uniqueReferences.values()]);
      for (const [key, state] of refreshedStates) {
        setBoundedPullRequestCacheEntry(pullRequestStateCache, key, { state, checkedAt });
      }

      let accepted = 0;
      let woken = 0;
      for (const candidate of eligible) {
        const allMerged = candidate.references.every((reference) => {
          const key = `${candidate.issue.companyId}:${reference.owner.toLowerCase()}/${reference.repo.toLowerCase()}#${reference.number}`;
          return pullRequestStateCache.get(key)?.state === "merged";
        });
        if (!allMerged) continue;

        let resolved: Awaited<ReturnType<typeof acceptRequestConfirmation>>;
        try {
          resolved = await acceptRequestConfirmation({
            issue: candidate.issue,
            current: candidate.interaction,
            input: {},
            actor: {
              systemId: "system:pr-merged",
              resolutionDetails: {
                source: "merged_pull_request_sweep",
                pullRequests: candidate.references.map((reference) =>
                  `${reference.owner}/${reference.repo}#${reference.number}`
                ),
              },
            },
          });
        } catch (error) {
          if (error && typeof error === "object" && "status" in error && error.status === 409) continue;
          throw error;
        }
        if (resolved.interaction.status !== "accepted") continue;
        accepted += 1;

        const wakeIssue = resolved.continuationIssue ?? candidate.issue;
        const shouldWake = resolved.interaction.continuationPolicy === "wake_assignee"
          || resolved.interaction.continuationPolicy === "wake_assignee_on_accept";
        if (!opts.wakeup || !shouldWake || !wakeIssue.assigneeAgentId || isTerminalIssueStatus(wakeIssue.status)) {
          continue;
        }
        await opts.wakeup(wakeIssue.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          payload: {
            issueId: wakeIssue.id,
            interactionId: resolved.interaction.id,
            interactionKind: resolved.interaction.kind,
            interactionStatus: resolved.interaction.status,
            sourceCommentId: resolved.interaction.sourceCommentId ?? null,
            sourceRunId: resolved.interaction.sourceRunId ?? null,
            mutation: "interaction",
            resolutionSource: "merged_pull_request_sweep",
          },
          idempotencyKey: `interaction:${resolved.interaction.id}:accepted`,
          requestedByActorType: "system",
          requestedByActorId: "system:pr-merged",
          contextSnapshot: {
            issueId: wakeIssue.id,
            taskId: wakeIssue.id,
            interactionId: resolved.interaction.id,
            interactionKind: resolved.interaction.kind,
            interactionStatus: resolved.interaction.status,
            wakeReason: "issue_commented",
            source: "merged_pull_request_sweep",
          },
        });
        woken += 1;
      }

      return { checked: rows.length, candidates: eligible.length, accepted, woken };
    },
    listForIssue: async (issueId: string) => {
      const [rows, issueStatus] = await Promise.all([
        db
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.issueId, issueId))
          .orderBy(asc(issueThreadInteractions.createdAt), asc(issueThreadInteractions.id)),
        db
          .select({ status: issues.status })
          .from(issues)
          .where(eq(issues.id, issueId))
          .then((issueRows) => issueRows[0]?.status ?? null),
      ]);

      return rows.map((row) => hydrateInteraction(
        issueStatus && isTerminalIssueStatus(issueStatus) && row.status === "pending"
          ? {
              ...row,
              status: "expired",
              result: buildAdministrativeOutcomeResult(row, "issue_closed"),
              resolvedAt: row.updatedAt,
            }
          : row,
      ));
    },

    getById: async (interactionId: string) => {
      const row = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      return row ? hydrateInteraction(row) : null;
    },

    recordSecretProposalExecutionResult: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      proposalId: string,
      execution: { status: "executed" | "failed"; errorCode?: string | null },
    ) => {
      const updated = await db.transaction(async (tx) => {
        // Verdict and terminal-transition paths lock issue -> proposal ->
        // interaction. Take the same order before recording the receipt so a
        // concurrent rejection or issue close cannot deadlock here.
        const lockedIssue = await tx
          .select({ id: issues.id })
          .from(issues)
          .where(and(
            eq(issues.id, issue.id),
            eq(issues.companyId, issue.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!lockedIssue) throw notFound("Issue not found");

        const proposal = await tx
          .select()
          .from(companySecretProposals)
          .where(and(
            eq(companySecretProposals.id, proposalId),
            eq(companySecretProposals.companyId, issue.companyId),
          ))
          .for("update")
          .then((rows) => rows[0] ?? null);
        const current = await tx
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interactionId))
          .for("update")
          .then((rows) => rows[0] ?? null);
        if (!current || current.companyId !== issue.companyId || current.issueId !== issue.id) {
          throw notFound("Interaction not found");
        }
        if (
          !proposal
          || proposal.interactionId !== interactionId
          || current.status !== "accepted"
          || linkedSecretProposalId(current) !== proposalId
        ) {
          throw conflict("Secret proposal interaction is not awaiting an execution result");
        }
        const now = new Date();
        const payload = current.payload && typeof current.payload === "object" && !Array.isArray(current.payload)
          ? current.payload as unknown as Record<string, unknown>
          : {};
        const secretProposalPayload = payload.secretProposal && typeof payload.secretProposal === "object"
          && !Array.isArray(payload.secretProposal)
          ? payload.secretProposal as Record<string, unknown>
          : {};
        const proposalAlreadyExecuted = proposal.status === "approved"
          && proposal.appliedBindingConfigPath === secretProposalPayload.configPath;
        const executionStatus = proposalAlreadyExecuted ? "executed" : execution.status;
        if (executionStatus === "failed" && proposal.status === "pending") {
          const resolutionReason = `Interaction acceptance failed: ${execution.errorCode ?? "secret_proposal_execution_failed"}`;
          await tx
            .update(companySecretProposals)
            .set({
              status: "rejected",
              resolvedByUserId: current.resolvedByUserId ?? null,
              resolvedAt: now,
              resolutionReason,
              valueCiphertext: null,
              ciphertextScrubbedAt: now,
              updatedAt: now,
            })
            .where(and(
              eq(companySecretProposals.id, proposal.id),
              eq(companySecretProposals.status, "pending"),
            ));
          await logActivity(tx as unknown as Db, {
            companyId: issue.companyId,
            actorType: current.resolvedByUserId ? "user" : "system",
            actorId: current.resolvedByUserId ?? "system",
            action: "secret.proposal.rejected",
            entityType: "company_secret_proposal",
            entityId: proposal.id,
            agentId: proposal.proposedByAgentId,
            runId: proposal.originRunId,
            details: {
              ciphertextScrubbed: true,
              issueId: proposal.originIssueId,
              interactionId: current.id,
              reason: resolutionReason,
              executionFailed: true,
            },
          });
        }
        const result = current.result && typeof current.result === "object" && !Array.isArray(current.result)
          ? current.result as unknown as Record<string, unknown>
          : {};
        const [row] = await tx
          .update(issueThreadInteractions)
          .set({
            result: {
              ...result,
              version: 1,
              outcome: "accepted",
              secretProposal: {
                version: 1,
                status: executionStatus,
                errorCode: executionStatus === "failed" ? execution.errorCode ?? null : null,
                updatedAt: now.toISOString(),
              },
            },
            updatedAt: now,
          })
          .where(eq(issueThreadInteractions.id, current.id))
          .returning();
        await touchIssue(tx, issue.id);
        return row;
      });
      return hydrateInteraction(updated);
    },

    cancelPendingForDeletedAddressee: async (companyId: string, addresseeAgentId: string) => {
      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.addresseeAgentId, addresseeAgentId),
          eq(issueThreadInteractions.status, "pending"),
        ));
      if (rows.length === 0) return [];

      const now = new Date();
      const cancelled: IssueThreadInteraction[] = [];
      for (const row of rows) {
        const [updated] = await db
          .update(issueThreadInteractions)
          .set({
            status: "cancelled",
            result: buildAdministrativeOutcomeResult(
              row,
              "addressee_deleted",
              "Cancelled because the addressed agent was deleted",
            ),
            resolvedByAgentId: null,
            resolvedByRunId: null,
            resolvedByUserId: null,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(issueThreadInteractions.id, row.id),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();
        if (updated) cancelled.push(hydrateInteraction(updated));
      }

      for (const issueId of new Set(cancelled.map((interaction) => interaction.issueId))) {
        await touchIssue(db, issueId);
      }
      await emitResolvedInteractionsTelemetry(db, cancelled);
      return cancelled;
    },

    sweepSupersededPendingRequestConfirmations: async () => {
      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.kind, "request_confirmation"),
          eq(issueThreadInteractions.status, "pending"),
          isNotNull(issueThreadInteractions.createdByAgentId),
        ))
        .orderBy(
          asc(issueThreadInteractions.companyId),
          asc(issueThreadInteractions.issueId),
          asc(issueThreadInteractions.kind),
          asc(issueThreadInteractions.createdByAgentId),
          desc(issueThreadInteractions.createdAt),
          desc(issueThreadInteractions.id),
        );

      const newestByGroup = new Map<string, IssueThreadInteractionRow>();
      const supersededRows: Array<{
        row: IssueThreadInteractionRow;
        replacementInteractionId: string;
      }> = [];
      for (const row of rows) {
        if (!row.createdByAgentId) continue;
        const groupKey = `${row.companyId}:${row.issueId}:${row.kind}:${row.createdByAgentId}`;
        const newest = newestByGroup.get(groupKey);
        if (!newest) {
          newestByGroup.set(groupKey, row);
          continue;
        }
        supersededRows.push({ row, replacementInteractionId: newest.id });
      }

      if (supersededRows.length === 0) return { expired: 0 };

      const now = new Date();
      const expired: IssueThreadInteraction[] = [];
      for (const { row, replacementInteractionId } of supersededRows) {
        const updated = await db.transaction(async (tx) => {
          const [updatedRow] = await tx
            .update(issueThreadInteractions)
            .set({
              status: "expired",
              result: buildSupersededByNewerRequestResult(replacementInteractionId),
              resolvedByAgentId: null,
              resolvedByUserId: null,
              resolvedAt: now,
              updatedAt: now,
            })
            .where(and(
              eq(issueThreadInteractions.id, row.id),
              eq(issueThreadInteractions.status, "pending"),
            ))
            .returning();
          if (!updatedRow) return null;
          await resolveLinkedToolActionRequests(tx, updatedRow, {
            status: "expired",
            fromStatuses: ["pending", "approved"],
            actor: {},
            now,
          });
          return updatedRow;
        });
        if (!updated) continue;
        expired.push(hydrateInteraction(updated));
      }

      if (expired.length > 0) {
        for (const issueId of new Set(expired.map((interaction) => interaction.issueId))) {
          await touchIssue(db, issueId);
        }
        await emitResolvedInteractionsTelemetry(db, expired);
      }
      return { expired: expired.length };
    },

    create: async (
      issue: { id: string; companyId: string },
      input: CreateIssueThreadInteraction,
      actor: InteractionActor,
      options: CreateInteractionOptions = {},
    ) => {
      const data = normalizeCreateInteractionInput(createIssueThreadInteractionSchema.parse(input));
      const usedDeprecatedResolverPolicyAlias =
        data.resolverPolicy === "board_or_agents" || data.resolverPolicy === "board_only";
      const governance = await db
        .select({ interactionResolverGovernance: companies.interactionResolverGovernance })
        .from(companies)
        .where(eq(companies.id, issue.companyId))
        .then((rows) => rows[0]?.interactionResolverGovernance ?? {});
      const policy = resolveInteractionPolicy({
        kind: data.kind,
        requested: data.resolverPolicy,
        governance,
        hasToolAction: data.kind === "request_confirmation" && data.payload.toolAction !== undefined,
        hasSecretProposal: data.kind === "request_confirmation" && data.payload.secretProposal !== undefined,
      });
      const normalizedData = { ...data, resolverPolicy: policy.requestedResolverPolicy };

      if (normalizedData.addresseeAgentId && normalizedData.addresseeUserId) {
        throw unprocessable("An issue-thread interaction cannot address both an agent and a user");
      }

      if (normalizedData.addresseeAgentId) {
        if (normalizedData.addresseeAgentId === actor.agentId) {
          throw unprocessable("Agents cannot address issue-thread interactions to themselves");
        }
        if (normalizedData.kind === "request_confirmation" && normalizedData.payload.toolAction !== undefined) {
          throw unprocessable("Tool-action confirmations cannot be addressed to agents");
        }
        if (normalizedData.kind === "request_confirmation" && normalizedData.payload.secretProposal !== undefined) {
          throw unprocessable("Secret-proposal confirmations cannot be addressed to agents");
        }
        const addressee = await db
          .select({
            id: agents.id,
            companyId: agents.companyId,
            name: agents.name,
            reportsTo: agents.reportsTo,
            status: agents.status,
          })
          .from(agents)
          .where(eq(agents.id, normalizedData.addresseeAgentId))
          .then((rows) => rows[0] ?? null);
        if (!addressee || addressee.companyId !== issue.companyId) {
          throw unprocessable("addresseeAgentId must belong to the same company");
        }
        const invokability = await evaluateAgentInvokabilityFromDb(db, addressee);
        if (!invokability.invokable) {
          throw unprocessable("addresseeAgentId must reference an invokable agent", {
            reason: invokability.reason,
            ...invokability.details,
          });
        }
      }

      if (normalizedData.idempotencyKey) {
        const existing = await getIdempotentInteraction({
          issueId: issue.id,
          companyId: issue.companyId,
          idempotencyKey: normalizedData.idempotencyKey,
        });
        if (existing) {
          if (!isEquivalentCreateRequest(existing, normalizedData, actor)) {
            throw conflict("Interaction idempotency key already exists for a different request", {
              idempotencyKey: normalizedData.idempotencyKey,
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

      const requiresCurrentTarget =
        data.kind === "request_confirmation"
        || data.kind === "request_checkbox_confirmation"
        || data.kind === "request_item_verdicts";

      let created: IssueThreadInteractionRow;
      let superseded: IssueThreadInteractionRow[] = [];
      try {
        // A terminal issue must not regain pending actionable cards. FOR UPDATE
        // on the issue row serializes this insert both against terminal status
        // transitions and against concurrent confirmations on the same issue.
        // Idempotent reuse above stays allowed so retries of a pre-close
        // create keep returning the (by now expired) original.
        const result = await db.transaction(async (tx) => {
          const [issueRow] = await tx
            .select({ status: issues.status })
            .from(issues)
            .where(and(eq(issues.id, issue.id), eq(issues.companyId, issue.companyId)))
            .for("update");
          if (!issueRow || isTerminalIssueStatus(issueRow.status)) {
            throw conflict("Cannot create an interaction on a closed issue");
          }
          // Validate the plan/document confirmation target inside the same
          // transaction (locking the document row) so the latest-revision check
          // is atomic with the insert below. A concurrent revision publish can no
          // longer slip between the check and the insert to leave a confirmation
          // pointing at a stale revision.
          if (requiresCurrentTarget) {
            await assertRequestConfirmationTargetIsCurrent(tx, {
              companyId: issue.companyId,
              issueId: issue.id,
              target: data.payload.target ?? null,
              lockForUpdate: true,
            });
          }
          const [row] = await tx
            .insert(issueThreadInteractions)
            .values({
              companyId: issue.companyId,
              issueId: issue.id,
              kind: data.kind,
              status: "pending",
              continuationPolicy: data.continuationPolicy,
              requestedResolverPolicy: policy.requestedResolverPolicy,
              effectiveResolverPolicy: policy.effectiveResolverPolicy,
              resolverPolicyProvenance: policy.resolverPolicyProvenance,
              effectiveResolverPolicySource: policy.effectiveResolverPolicySource,
              idempotencyKey: data.idempotencyKey ?? null,
              sourceCommentId: data.sourceCommentId ?? null,
              sourceRunId: data.sourceRunId ?? null,
              title: data.title ?? null,
              summary: data.summary ?? null,
              createdByAgentId: actor.agentId ?? null,
              addresseeAgentId: data.addresseeAgentId ?? null,
              addresseeUserId: data.addresseeUserId ?? null,
              createdByUserId: actor.userId ?? null,
              payload: data.payload,
            })
            .returning();

          // An agent replacing its own still-pending card supersedes the older
          // one so the thread never accumulates stale sibling cards. This covers
          // request_confirmation drafts and ask_user_questions (PAP-437: probe
          // question cards that agents never withdrew). Each kind keeps its own
          // result shape. Scoped strictly to the same agent + issue + kind, so
          // other agents' or other kinds' pending cards are untouched.
          const canSupersedeSiblingCards =
            options.supersedePendingSiblingInteractions !== false
            && (
              (data.kind === "request_confirmation"
                && data.payload.toolAction === undefined
                && data.payload.secretProposal === undefined)
              || data.kind === "ask_user_questions"
            );
          if (!actor.agentId || !canSupersedeSiblingCards) {
            return { row, supersededRows: [] };
          }

          const now = new Date();
          const supersededResult = data.kind === "ask_user_questions"
            ? buildSupersededByNewerInteractionResult(row.id)
            : buildSupersededByNewerRequestResult(row.id);
          const supersededRows = await tx
            .update(issueThreadInteractions)
            .set({
              status: "expired",
              result: supersededResult,
              resolvedByAgentId: actor.agentId,
              resolvedByUserId: actor.userId ?? null,
              resolvedAt: now,
              updatedAt: now,
            })
            .where(and(
              eq(issueThreadInteractions.companyId, issue.companyId),
              eq(issueThreadInteractions.issueId, issue.id),
              eq(issueThreadInteractions.kind, data.kind),
              eq(issueThreadInteractions.createdByAgentId, actor.agentId),
              eq(issueThreadInteractions.status, "pending"),
              ne(issueThreadInteractions.id, row.id),
            ))
            .returning();
          for (const supersededRow of supersededRows) {
            await resolveLinkedToolActionRequests(tx, supersededRow, {
              status: "expired",
              fromStatuses: ["pending", "approved"],
              actor,
              now,
            });
          }
          return { row, supersededRows };
        });
        created = result.row;
        superseded = result.supersededRows;
      } catch (error) {
        if (!normalizedData.idempotencyKey || !isIssueThreadInteractionIdempotencyConflict(error)) {
          throw error;
        }
        const existing = await getIdempotentInteraction({
          issueId: issue.id,
          companyId: issue.companyId,
          idempotencyKey: normalizedData.idempotencyKey,
        });
        if (!existing) throw error;
        if (!isEquivalentCreateRequest(existing, normalizedData, actor)) {
          throw conflict("Interaction idempotency key already exists for a different request", {
            idempotencyKey: normalizedData.idempotencyKey,
          });
        }
        return hydrateInteraction(existing);
      }

      await touchIssue(db, issue.id);
      if (superseded.length > 0) {
        await emitResolvedInteractionsTelemetry(db, superseded.map(hydrateInteraction));
      }
      const interaction = hydrateInteraction(created);
      emitInteractionCreatedTelemetry({
        interactionKind: interaction.kind,
        usedDeprecatedResolverPolicyAlias,
      });
      return interaction;
    },

    acceptInteraction: async (
      issue: { id: string; companyId: string; projectId: string | null; goalId: string | null; status?: string },
      interactionId: string,
      input: AcceptIssueThreadInteraction,
      actor: InteractionActor,
    ): Promise<ResolvedInteractionResult> => {
      const data = acceptIssueThreadInteractionSchema.parse(input);
      const current = await getPendingInteractionForResolution({ issue, interactionId });
      assertInteractionResolutionAllowed(current, actor);
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
      issue: { id: string; companyId: string; projectId: string | null; goalId: string | null; status?: string },
      interactionId: string,
      input: AcceptIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      assertIssueOpenForInteractionResolution(issue);
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw interactionNotFoundError();
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw interactionNotFoundError();
      }
      assertInteractionResolutionAllowed(current, actor);
      if (current.kind !== "suggest_tasks") {
        throw unprocessable("Only suggest_tasks interactions can be accepted");
      }
      if (current.status !== "pending") {
        throw interactionTerminalError(current);
      }
      if (actor.agentId && actor.suggestedTaskEffectsAuthorized !== true) {
        throw issueThreadInteractionResolutionError(
          403,
          "interaction_governed_action_denied",
          "Suggested-task creation requires independent task-creation authorization",
        );
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
            resolvedByRunId: actor.runId ?? null,
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
          throw interactionAlreadyResolvedError();
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
      issue: { id: string; companyId: string; status?: string },
      interactionId: string,
      input: RejectIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      const data = rejectIssueThreadInteractionSchema.parse(input);
      const current = await getPendingInteractionForResolution({ issue, interactionId });
      assertInteractionResolutionAllowed(current, actor);
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

    submitItemVerdicts: async (
      issue: { id: string; companyId: string; status?: string },
      interactionId: string,
      input: SubmitIssueThreadInteractionVerdicts,
      actor: InteractionActor,
    ): Promise<{ interaction: IssueThreadInteraction; newlyResolvedItemIds: string[] }> => {
      assertIssueOpenForInteractionResolution(issue);
      const data = submitIssueThreadInteractionVerdictsSchema.parse(input);
      const submission = await db.transaction(async (tx) => {
        const current = await tx
          .select()
          .from(issueThreadInteractions)
          .where(eq(issueThreadInteractions.id, interactionId))
          .for("update")
          .then((rows) => rows[0] ?? null);

        if (!current) throw interactionNotFoundError();
        if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
          throw interactionNotFoundError();
        }
        if (current.kind !== "request_item_verdicts") {
          throw unprocessable("Only request_item_verdicts interactions can receive item verdicts");
        }

        assertInteractionResolutionAllowed(current, actor);
        const interaction = hydrateInteraction(current) as RequestItemVerdictsInteraction;
        if (current.status !== "pending") {
          if (current.status === "answered") {
            const resolvedIds = new Set(interaction.result?.items.map((item) => item.id) ?? []);
            const payloadIds = new Set(interaction.payload.items.map((item) => item.id));
            for (const submitted of data.verdicts) {
              if (!payloadIds.has(submitted.id)) {
                throw unprocessable(`Unknown item verdict id: ${submitted.id}`);
              }
              if (!resolvedIds.has(submitted.id)) {
                throw interactionTerminalError(current);
              }
            }
            return { interaction, newlyResolvedItemIds: [], resolved: false };
          }
          throw interactionTerminalError(current);
        }
        const expired = await expireStaleRequestConfirmationTarget(tx, {
          row: current,
          actor,
        });
        if (expired) {
          return {
            interaction: expired,
            newlyResolvedItemIds: [],
            resolved: false,
            terminalError: interactionTerminalError({ status: expired.status, result: expired.result }),
          };
        }

        const now = new Date();
        const { items, complete, newlyResolvedItemIds } = resolveRequestItemVerdictSubmissions({
          interaction,
          input: data,
          actor,
          now,
        });
        if (newlyResolvedItemIds.length === 0) {
          return { interaction, newlyResolvedItemIds: [], resolved: false };
        }

        const result = {
          version: 1,
          outcome: "resolved",
          complete,
          items,
        } satisfies RequestItemVerdictsResult;
        const [updated] = await tx
          .update(issueThreadInteractions)
          .set({
            status: complete ? "answered" : "pending",
            result,
            resolvedByAgentId: complete ? actor.agentId ?? null : null,
            resolvedByRunId: complete ? actor.runId ?? null : null,
            resolvedByUserId: complete ? actor.userId ?? null : null,
            resolvedAt: complete ? now : null,
            updatedAt: now,
          })
          .where(and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();

        if (!updated) {
          throw interactionAlreadyResolvedError();
        }

        await touchIssue(tx, issue.id);
        return {
          interaction: hydrateInteraction(updated),
          newlyResolvedItemIds,
          resolved: complete,
        };
      });

      if ("terminalError" in submission) throw submission.terminalError;
      if (submission.resolved) {
        await emitInteractionResolvedTelemetry(db, submission.interaction);
      }
      return submission;
    },

    rejectSuggestedTasks: async (
      issue: { id: string; companyId: string; status?: string },
      interactionId: string,
      input: RejectIssueThreadInteraction,
      actor: InteractionActor,
      current: IssueThreadInteractionRow,
    ) => {
      assertIssueOpenForInteractionResolution(issue);
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw interactionNotFoundError();
      }
      if (current.kind !== "suggest_tasks") {
        throw unprocessable("Only suggest_tasks interactions can be rejected");
      }
      if (current.status !== "pending") {
        throw interactionTerminalError(current);
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
          resolvedByRunId: actor.runId ?? null,
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
        throw interactionAlreadyResolvedError();
      }

      await touchIssue(db, issue.id);
      const rejected = hydrateInteraction(updated);
      await emitInteractionResolvedTelemetry(db, rejected);
      return rejected;
    },

    expireRequestConfirmationsSupersededByComment: async (
      issue: { id: string; companyId: string; status?: string },
      comment: { id: string; createdAt: Date | string; authorUserId?: string | null; createdByRunId?: string | null },
      actor: InteractionActor,
    ) => {
      if (!comment.authorUserId) return [];
      // Local-CLI adapters post under user auth, so authorUserId can't tell a human from a
      // machine; createdByRunId can. Only genuine human comments (no run context) supersede.
      if (comment.createdByRunId) return [];

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
        const [updated] = await db.transaction(async (tx) => {
          if (row.kind === "connection_intent") {
            await tx.delete(toolOauthStates).where(eq(toolOauthStates.interactionId, row.id));
          }
          return tx
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
        });
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
            // Only genuine human comments supersede; machine-originated ones carry createdByRunId.
            isNull(issueComments.createdByRunId),
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
        const itemVerdictRows = commentRows
          .filter((row) => row.kind === "request_item_verdicts");
        const connectionIntentRows = commentRows
          .filter((row) => row.kind === "connection_intent");

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

        for (const row of itemVerdictRows) {
          const [updated] = await db
            .update(issueThreadInteractions)
            .set({
              status: "expired",
              result: buildSupersededByCommentResult(row, comment.id),
              resolvedByAgentId: null,
              resolvedByUserId: comment.authorUserId,
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

        for (const row of connectionIntentRows) {
          const [updated] = await db.transaction(async (tx) => {
            await tx.delete(toolOauthStates).where(eq(toolOauthStates.interactionId, row.id));
            return tx
              .update(issueThreadInteractions)
              .set({
                status: "expired",
                result: buildSupersededByCommentResult(row, comment.id),
                resolvedByAgentId: null,
                resolvedByUserId: comment.authorUserId,
                resolvedAt: now,
                updatedAt: now,
              })
              .where(and(
                eq(issueThreadInteractions.id, row.id),
                eq(issueThreadInteractions.status, "pending"),
              ))
              .returning();
          });
          if (updated) expired.push(hydrateInteraction(updated));
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
          inArray(issueThreadInteractions.kind, [...TARGET_BOUND_INTERACTION_KINDS]),
          eq(issueThreadInteractions.status, "pending"),
        ));

      const staleRows = rows.filter((row) => {
        const interaction = hydrateInteraction(row) as TargetBoundInteraction;
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
        const interaction = hydrateInteraction(row) as TargetBoundInteraction;
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
            result: buildStaleTargetResult(row, target),
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

    expirePendingInteractionsForTerminalIssue: async (
      issue: { id: string; companyId: string; status: string },
      actor: InteractionActor = {},
    ) => {
      if (!isTerminalIssueStatus(issue.status)) return [];
      const rows = await db
        .select()
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, issue.companyId),
          eq(issueThreadInteractions.issueId, issue.id),
          eq(issueThreadInteractions.status, "pending"),
        ));
      if (rows.length === 0) return [];

      const now = new Date();
      const expired: IssueThreadInteraction[] = [];
      for (const row of rows) {
        // Same ordering as withdrawal: revoke the linked tool action before
        // resolving the card, inside one transaction. A concurrent gateway
        // claim (approved -> executing) blocks on the revocation's row lock
        // and then aborts; if the card was concurrently resolved instead, the
        // no-row update below rolls the revocation back. A claim that already
        // committed is in flight and cannot be recalled — the card still
        // expires and the execution result lands on it via the gateway's
        // lifecycle reflection.
        const updated = await db.transaction(async (tx) => {
          if (row.kind === "connection_intent") {
            await tx
              .delete(toolOauthStates)
              .where(eq(toolOauthStates.interactionId, row.id));
          }
          await resolveLinkedToolActionRequests(tx, row, {
            status: "expired",
            fromStatuses: ["pending", "approved"],
            actor,
            now,
          });
          await resolveLinkedSecretProposal(tx as unknown as Db, row, {
            status: "expired",
            actor,
            reason: "Issue closed before the secret proposal was resolved",
            now,
          });
          const [resolved] = await tx
            .update(issueThreadInteractions)
            .set({
              status: "expired",
              result: buildAdministrativeOutcomeResult(row, "issue_closed"),
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
          if (!resolved) throw new InteractionResolvedConcurrentlyError();
          return resolved;
        }).catch((err: unknown) => {
          if (err instanceof InteractionResolvedConcurrentlyError) return null;
          throw err;
        });
        if (updated) expired.push(hydrateInteraction(updated));
      }
      if (expired.length > 0) {
        await touchIssue(db, issue.id);
        await emitResolvedInteractionsTelemetry(db, expired);
      }
      return expired;
    },

    withdrawInteraction: async (
      issue: { id: string; companyId: string },
      interactionId: string,
      input: WithdrawIssueThreadInteraction,
      actor: InteractionActor,
      mutationOptions: InteractionResolutionMutationOptions = {},
    ) => {
      assertIssueOpenForInteractionResolution(issue);
      const data = withdrawIssueThreadInteractionSchema.parse(input);
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);
      if (!current || current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw interactionNotFoundError();
      }
      if (current.status !== "pending") throw interactionTerminalError(current);

      const reason = data.reason?.trim() || null;
      const now = new Date();
      // One transaction, linked tool action first: revoking pending/approved
      // requests before resolving the card means a concurrent gateway claim
      // (approved -> executing) either loses to the revocation's row lock or
      // is detected below and aborts the withdrawal; a concurrent card
      // resolution rolls the revocation back via the status="pending" guard.
      // "approved" is revoked too — the request can be approved from the tool
      // review queue while the card is still pending, and an executable
      // request must not outlive a withdrawn card.
      const updated = await db.transaction(async (tx) => {
        await resolveLinkedToolActionRequests(tx, current, {
          status: "cancelled",
          fromStatuses: ["pending", "approved"],
          actor,
          now,
        });
        await resolveLinkedSecretProposal(tx as unknown as Db, current, {
          status: "withdrawn",
          actor,
          reason,
          now,
        });
        if (current.kind === "request_confirmation") {
          const active = await tx
            .select({ id: toolActionRequests.id })
            .from(toolActionRequests)
            .where(and(
              eq(toolActionRequests.companyId, current.companyId),
              eq(toolActionRequests.interactionId, current.id),
              inArray(toolActionRequests.status, ["executing", "executed"]),
            ))
            .then((rows) => rows[0] ?? null);
          if (active) throw conflict("The linked tool action is already executing and can no longer be withdrawn");
        }
        const [row] = await tx
          .update(issueThreadInteractions)
          .set({
            status: "cancelled",
            result: buildAdministrativeOutcomeResult(current, "withdrawn", reason),
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByRunId: actor.runId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();
        if (!row) throw interactionAlreadyResolvedError();
        await mutationOptions.afterResolveInTransaction?.(tx, hydrateInteraction(row));
        return row;
      });

      await touchIssue(db, issue.id);
      const withdrawn = hydrateInteraction(updated);
      await emitInteractionResolvedTelemetry(db, withdrawn);
      return withdrawn;
    },

    answerQuestions: async (
      issue: { id: string; companyId: string; status?: string },
      interactionId: string,
      input: RespondIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      assertIssueOpenForInteractionResolution(issue);
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw interactionNotFoundError();
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw interactionNotFoundError();
      }
      assertInteractionResolutionAllowed(current, actor);
      if (current.kind !== "ask_user_questions") {
        throw unprocessable("Only ask_user_questions interactions can be answered");
      }
      if (current.status !== "pending") {
        throw interactionTerminalError(current);
      }

      const interaction = hydrateInteraction(current) as AskUserQuestionsInteraction;
      const normalizedAnswers = normalizeQuestionAnswers({
        questions: interaction.payload.questions,
        answers: input.answers,
      });

      const updated = await db.transaction(async (tx) => {
        const resolvedAt = new Date();
        const [row] = await tx
          .update(issueThreadInteractions)
          .set({
            status: "answered",
            result: {
              version: 1,
              answers: normalizedAnswers,
              summaryMarkdown: input.summaryMarkdown ?? null,
            },
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByRunId: actor.runId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt,
            updatedAt: resolvedAt,
          })
          .where(and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();

        if (!row) throw interactionAlreadyResolvedError();
        const answered = hydrateInteraction(row) as AskUserQuestionsInteraction;
        await tx.insert(issueQuestionResponseDeliveries).values(
          questionResponseDeliveryValues(answered),
        );
        return row;
      });

      await touchIssue(db, issue.id);
      const answered = hydrateInteraction(updated);
      await emitInteractionResolvedTelemetry(db, answered);
      return answered;
    },

    skipInteraction: async (
      issue: { id: string; companyId: string; status?: string },
      interactionId: string,
      input: SkipIssueThreadInteraction,
      actor: InteractionActor,
    ) => {
      assertIssueOpenForInteractionResolution(issue);
      const data = skipIssueThreadInteractionSchema.parse(input);
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current || current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw interactionNotFoundError();
      }
      if (current.status !== "pending") throw interactionTerminalError(current);

      const reason = data.reason?.trim() || null;
      const now = new Date();
      const updated = await db.transaction(async (tx) => {
        await resolveLinkedToolActionRequests(tx, current, {
          status: "cancelled",
          fromStatuses: ["pending", "approved"],
          actor,
          now,
        });
        await resolveLinkedSecretProposal(tx as unknown as Db, current, {
          status: "withdrawn",
          actor,
          reason: reason ?? "Skipped from the task composer",
          now,
        });

        if (current.kind === "request_confirmation") {
          const active = await tx
            .select({ id: toolActionRequests.id })
            .from(toolActionRequests)
            .where(and(
              eq(toolActionRequests.companyId, current.companyId),
              eq(toolActionRequests.interactionId, current.id),
              inArray(toolActionRequests.status, ["executing", "executed"]),
            ))
            .then((rows) => rows[0] ?? null);
          if (active) throw conflict("The linked tool action has begun executing and can no longer be skipped");
        }

        const [row] = await tx
          .update(issueThreadInteractions)
          .set({
            status: "cancelled",
            result: buildSkippedOutcomeResult(current, reason),
            resolvedByAgentId: actor.agentId ?? null,
            resolvedByRunId: actor.runId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt: now,
            updatedAt: now,
          })
          .where(and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();
        if (!row) throw interactionAlreadyResolvedError();
        return row;
      });

      await touchIssue(db, issue.id);
      const skipped = hydrateInteraction(updated);
      await emitInteractionResolvedTelemetry(db, skipped);
      return skipped;
    },

    cancelQuestions: async (
      issue: { id: string; companyId: string; status?: string },
      interactionId: string,
      input: CancelIssueThreadInteraction,
      actor: InteractionActor,
      mutationOptions: InteractionResolutionMutationOptions = {},
    ) => {
      assertIssueOpenForInteractionResolution(issue);
      const data = cancelIssueThreadInteractionSchema.parse(input);
      const current = await db
        .select()
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interactionId))
        .then((rows) => rows[0] ?? null);

      if (!current) throw interactionNotFoundError();
      if (current.companyId !== issue.companyId || current.issueId !== issue.id) {
        throw interactionNotFoundError();
      }
      if (current.kind !== "ask_user_questions") {
        throw unprocessable("Only ask_user_questions interactions can be cancelled");
      }
      if (current.status !== "pending") {
        throw interactionTerminalError(current);
      }

      const reason = data.reason?.trim() || null;
      const updated = await db.transaction(async (tx) => {
        const resolvedAt = new Date();
        const [row] = await tx
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
            resolvedByRunId: actor.runId ?? null,
            resolvedByUserId: actor.userId ?? null,
            resolvedAt,
            updatedAt: resolvedAt,
          })
          .where(and(
            eq(issueThreadInteractions.id, interactionId),
            eq(issueThreadInteractions.status, "pending"),
          ))
          .returning();

        if (!row) throw interactionAlreadyResolvedError();
        await mutationOptions.afterResolveInTransaction?.(tx, hydrateInteraction(row));
        return row;
      });

      await touchIssue(db, issue.id);
      const cancelled = hydrateInteraction(updated);
      await emitInteractionResolvedTelemetry(db, cancelled);
      return cancelled;
    },
  };
}
