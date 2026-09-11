export type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  AskUserQuestionsPayload,
  AskUserQuestionsQuestion,
  AskUserQuestionsQuestionOption,
  AskUserQuestionsResult,
  ConnectionIntentInteraction,
  ConnectionIntentPayload,
  ConnectionIntentResult,
  IssueThreadInteraction,
  IssueThreadInteractionActorFields,
  IssueThreadInteractionBase,
  IssueThreadInteractionContinuationPolicy,
  IssueThreadInteractionStatus,
  RequestCheckboxConfirmationInteraction,
  RequestCheckboxConfirmationOption,
  RequestCheckboxConfirmationPayload,
  RequestCheckboxConfirmationResult,
  RequestConfirmationInteraction,
  RequestConfirmationIssueDocumentTarget,
  RequestConfirmationPayload,
  RequestConfirmationResult,
  RequestConfirmationSecretProposalPayload,
  RequestConfirmationSecretProposalResult,
  RequestConfirmationTarget,
  RequestConfirmationToolActionPayload,
  RequestConfirmationToolActionResult,
  RequestItemVerdictsInteraction,
  RequestItemVerdictsItem,
  RequestItemVerdictsPayload,
  RequestItemVerdictsResult,
  RequestItemVerdictsResultItem,
  RequestItemVerdictValue,
  SubmitIssueThreadInteractionVerdicts,
  SuggestedTaskDraft,
  SuggestTasksInteraction,
  SuggestTasksPayload,
  SuggestTasksResult,
  SuggestTasksResultCreatedTask,
} from "@paperclipai/shared";
import type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  AskUserQuestionsQuestion,
  ConnectionIntentInteraction,
  CreateIssueThreadInteraction,
  IssueThreadInteraction,
  IssueDocument,
  RequestCheckboxConfirmationPayload,
  RequestCheckboxConfirmationResult,
  RequestConfirmationInteraction,
  RequestConfirmationTarget,
  RequestItemVerdictsInteraction,
  RequestItemVerdictsPayload,
  RequestItemVerdictsResult,
  RequestItemVerdictValue,
  SuggestedTaskDraft,
  SuggestTasksInteraction,
  SuggestTasksResultCreatedTask,
} from "@paperclipai/shared";
import { isPlanningDocumentKey } from "./issue-artifacts";

export interface SuggestedTaskTreeNode {
  task: SuggestedTaskDraft;
  children: SuggestedTaskTreeNode[];
}

/**
 * These takeovers already expose a deliberate non-accept path in their form.
 * Showing the composer's generic Skip beside Reject/Revise duplicates that
 * escape hatch and makes the action hierarchy ambiguous.
 */
export function interactionReplacesComposerSkip(
  interaction: IssueThreadInteraction,
): boolean {
  return interaction.kind === "request_confirmation"
    || interaction.kind === "request_checkbox_confirmation"
    || interaction.kind === "suggest_tasks";
}

export function isIssueThreadInteraction(
  value: unknown,
): value is IssueThreadInteraction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<IssueThreadInteraction>;
  return typeof candidate.id === "string"
    && typeof candidate.companyId === "string"
    && typeof candidate.issueId === "string"
    && (
      candidate.kind === "suggest_tasks"
      || candidate.kind === "ask_user_questions"
      || candidate.kind === "request_confirmation"
      || candidate.kind === "request_checkbox_confirmation"
      || candidate.kind === "request_item_verdicts"
      || candidate.kind === "connection_intent"
    );
}

type ReviewableIssueDocument = Pick<
  IssueDocument,
  "id" | "issueId" | "key" | "latestRevisionId" | "latestRevisionNumber"
>;

type CreateRequestConfirmationInteraction = Extract<
  CreateIssueThreadInteraction,
  { kind: "request_confirmation" }
>;

export function buildPlanningDocumentReviewRequest(
  document: ReviewableIssueDocument,
): CreateRequestConfirmationInteraction {
  if (!isPlanningDocumentKey(document.key)) {
    throw new Error(`Unsupported planning document key: ${document.key}`);
  }
  if (!document.latestRevisionId) {
    throw new Error("Save the document before requesting review.");
  }
  const scopeOnly = document.key === "specification";
  const documentLabel = scopeOnly ? "Specification" : "Plan";
  return {
    kind: "request_confirmation",
    idempotencyKey: `confirmation:${document.issueId}:${document.key}:${document.latestRevisionId}`,
    title: scopeOnly ? "Specification approval" : "Implementation plan approval",
    summary: scopeOnly
      ? "Human scope review only; approval does not authorize implementation."
      : "Human review of this exact implementation plan revision.",
    continuationPolicy: "wake_assignee",
    resolverPolicy: "human_only",
    payload: {
      version: 1,
      prompt: scopeOnly ? "Approve this specification revision?" : "Approve this implementation plan revision?",
      acceptLabel: scopeOnly ? "Approve specification" : "Approve plan",
      rejectLabel: "Request changes",
      rejectRequiresReason: true,
      rejectReasonLabel: scopeOnly
        ? "What must change in the specification?"
        : "What must change before implementation?",
      allowDeclineReason: true,
      supersedeOnUserComment: true,
      detailsMarkdown: scopeOnly
        ? "This approves the scope-only `specification` revision. It does not change work mode and does not authorize implementation."
        : "On a planning-mode issue, approval of this exact `plan` revision changes work mode to standard and authorizes implementation.",
      target: {
        type: "issue_document",
        issueId: document.issueId,
        documentId: document.id,
        key: document.key,
        revisionId: document.latestRevisionId,
        revisionNumber: document.latestRevisionNumber,
        label: documentLabel,
        href: `#document-${encodeURIComponent(document.key)}&viewer=full`,
      },
    },
  };
}

export type CurrentIssueDocumentReviewState =
  | "unreviewed"
  | "waiting"
  | "approved"
  | "changes_requested"
  | "closed";

export interface CurrentIssueDocumentReview {
  state: CurrentIssueDocumentReviewState;
  interaction: RequestConfirmationInteraction | null;
}

export function isIssueDocumentReviewInteraction(
  interaction: IssueThreadInteraction,
  document: Pick<ReviewableIssueDocument, "id" | "issueId" | "key">,
): interaction is RequestConfirmationInteraction {
  if (interaction.kind !== "request_confirmation") return false;
  if (interaction.issueId !== document.issueId) return false;
  const target = interaction.payload.target;
  if (!target || target.type !== "issue_document" || target.key !== document.key) return false;
  if (target.issueId && target.issueId !== document.issueId) return false;
  if (target.documentId && target.documentId !== document.id) return false;
  return true;
}

/**
 * Derive review state from the newest confirmation aimed at the exact latest
 * document revision. Closed/stale newer requests intentionally suppress older
 * approvals so a prior receipt can never masquerade as current authorization.
 */
export function deriveCurrentIssueDocumentReview(
  interactions: readonly IssueThreadInteraction[] | null | undefined,
  document: ReviewableIssueDocument,
): CurrentIssueDocumentReview {
  if (!document.latestRevisionId) {
    return { state: "unreviewed", interaction: null };
  }

  let latest: RequestConfirmationInteraction | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;
  for (const interaction of interactions ?? []) {
    if (!isIssueDocumentReviewInteraction(interaction, document)) continue;
    const target = interaction.payload.target;
    if (
      target?.type !== "issue_document"
      || target.revisionId !== document.latestRevisionId
      || (
        target.revisionNumber != null
        && target.revisionNumber !== document.latestRevisionNumber
      )
    ) {
      continue;
    }
    const parsedTimestamp = new Date(interaction.createdAt).getTime();
    const timestamp = Number.isNaN(parsedTimestamp) ? 0 : parsedTimestamp;
    if (!latest || timestamp >= latestTimestamp) {
      latest = interaction;
      latestTimestamp = timestamp;
    }
  }

  if (!latest) return { state: "unreviewed", interaction: null };
  if (latest.result?.outcome === "stale_target") {
    return { state: "closed", interaction: latest };
  }
  if (latest.status === "pending") return { state: "waiting", interaction: latest };
  if (latest.status === "accepted") {
    return { state: latest.resolvedByUserId ? "approved" : "closed", interaction: latest };
  }
  if (latest.status === "rejected") {
    return { state: "changes_requested", interaction: latest };
  }
  return { state: "closed", interaction: latest };
}

export interface ItemVerdictProgress {
  total: number;
  decided: number;
  approved: number;
  rejected: number;
  deferred: number;
  /** ids in payload order that still have no verdict. */
  pendingItemIds: string[];
}

/**
 * Derive the `M of N decided` progress for a per-item verdict interaction from
 * its payload (the full item roster) and result (verdicts accumulated so far).
 * Present-tense verdict values (`approve`/`reject`/`defer`) are what the server
 * stores in `result.items[].verdict` (see PAP-13247).
 */
export function getItemVerdictProgress(args: {
  payload: RequestItemVerdictsPayload;
  result?: RequestItemVerdictsResult | null;
}): ItemVerdictProgress {
  const { payload, result } = args;
  const resolvedById = new Map<string, RequestItemVerdictValue>(
    (result?.items ?? []).map((item) => [item.id, item.verdict] as const),
  );
  let approved = 0;
  let rejected = 0;
  let deferred = 0;
  const pendingItemIds: string[] = [];
  for (const item of payload.items) {
    const verdict = resolvedById.get(item.id);
    if (verdict === "approve") approved += 1;
    else if (verdict === "reject") rejected += 1;
    else if (verdict === "defer") deferred += 1;
    else pendingItemIds.push(item.id);
  }
  const decided = approved + rejected + deferred;
  return { total: payload.items.length, decided, approved, rejected, deferred, pendingItemIds };
}

export function buildItemVerdictsSummary(
  interaction: RequestItemVerdictsInteraction,
): string {
  const progress = getItemVerdictProgress({
    payload: interaction.payload,
    result: interaction.result,
  });
  if (interaction.status === "answered") {
    const parts = [`${progress.decided} decided`];
    if (progress.approved > 0) parts.push(`${progress.approved} approved`);
    if (progress.rejected > 0) parts.push(`${progress.rejected} rejected`);
    if (progress.deferred > 0) parts.push(`${progress.deferred} deferred`);
    return parts.join(" · ");
  }
  if (interaction.status === "expired") {
    const outcome = interaction.result?.outcome;
    if (outcome === "superseded_by_comment") return "Verdicts expired after comment";
    if (outcome === "stale_target") return "Verdicts expired after target changed";
    return "Verdicts expired";
  }
  return `${progress.decided} of ${progress.total} decided`;
}

export function getCheckboxConfirmationSelectedLabels(args: {
  payload: RequestCheckboxConfirmationPayload;
  result?: RequestCheckboxConfirmationResult | null;
}): string[] {
  const { payload, result } = args;
  const selectedIds = result?.selectedOptionIds ?? [];
  const optionLabelById = new Map(
    payload.options.map((option) => [option.id, option.label] as const),
  );
  return selectedIds
    .map((optionId) => optionLabelById.get(optionId))
    .filter((label): label is string => typeof label === "string");
}

export function normalizeRequestConfirmationTargetHref(href: string) {
  const value = href.trim();
  if (value.startsWith("#")) return value;
  if (value.startsWith("/")) return value.startsWith("//") ? null : value;
  return /^https?:\/\//i.test(value) ? value : null;
}

export function getRequestConfirmationTargetHref({
  issueId,
  target,
}: {
  issueId: string;
  target: RequestConfirmationTarget;
}) {
  if (target.href) {
    const safeHref = normalizeRequestConfirmationTargetHref(target.href);
    if (safeHref) return safeHref;
  }
  if (target.type === "issue_document") {
    const targetIssueId = target.issueId ?? issueId;
    return `/issues/${targetIssueId}#document-${encodeURIComponent(target.key)}`;
  }
  return null;
}

export function buildIssueThreadInteractionSummary(
  interaction: IssueThreadInteraction,
) {
  const administrativeOutcome = interaction.result && "outcome" in interaction.result
    ? interaction.result.outcome
    : null;
  if (administrativeOutcome === "skipped") return "Skipped interaction";
  if (administrativeOutcome === "withdrawn") return "Withdrawn interaction";
  if (administrativeOutcome === "issue_closed") return "Expired when issue closed";
  if (administrativeOutcome === "addressee_deleted") return "Cancelled when addressee was deleted";
  if (interaction.kind === "suggest_tasks") {
    const count = interaction.payload.tasks.length;
    if (interaction.status === "accepted") {
      const createdCount = interaction.result?.createdTasks?.length ?? 0;
      const skippedCount = interaction.result?.skippedClientKeys?.length ?? 0;
      if (skippedCount > 0) {
        return `Accepted ${createdCount} of ${count} tasks`;
      }
      return createdCount === 1 ? "Accepted 1 task" : `Accepted ${createdCount} tasks`;
    }
    if (interaction.status === "rejected") {
      return count === 1 ? "Rejected 1 task" : `Rejected ${count} tasks`;
    }
    return count === 1 ? "Suggested 1 task" : `Suggested ${count} tasks`;
  }

  if (interaction.kind === "request_confirmation") {
    if (interaction.status === "accepted") return "Confirmed request";
    if (interaction.status === "rejected") {
      const rejectLabel = interaction.payload.rejectLabel?.trim();
      return rejectLabel ? `Selected “${rejectLabel}”` : "Declined request";
    }
    if (interaction.status === "expired") {
      const outcome = interaction.result?.outcome;
      if (outcome === "superseded_by_comment") return "Confirmation expired after comment";
      if (outcome === "stale_target") return "Confirmation expired after target changed";
      return "Confirmation expired";
    }
    return "Requested confirmation";
  }

  if (interaction.kind === "request_checkbox_confirmation") {
    const optionCount = interaction.payload.options.length;
    if (interaction.status === "accepted") {
      const selectedCount = interaction.result?.selectedOptionIds?.length ?? 0;
      if (selectedCount === 0) return "Confirmed with no options selected";
      return selectedCount === 1
        ? `Confirmed 1 of ${optionCount} options`
        : `Confirmed ${selectedCount} of ${optionCount} options`;
    }
    if (interaction.status === "rejected") return "Declined selection";
    if (interaction.status === "expired") {
      const outcome = interaction.result?.outcome;
      if (outcome === "superseded_by_comment") return "Selection expired after comment";
      if (outcome === "stale_target") return "Selection expired after target changed";
      return "Selection expired";
    }
    return optionCount === 1
      ? "Requested a selection from 1 option"
      : `Requested a selection from ${optionCount} options`;
  }

  if (interaction.kind === "request_item_verdicts") {
    return buildItemVerdictsSummary(interaction);
  }

  if (interaction.kind === "connection_intent") {
    if (interaction.status === "accepted") return `${interaction.payload.serviceName} connected`;
    if (interaction.status === "rejected") return `${interaction.payload.serviceName} declined`;
    if (interaction.status === "expired") {
      return interaction.result?.outcome === "superseded"
        ? `${interaction.payload.serviceName} request superseded`
        : `${interaction.payload.serviceName} request expired`;
    }
    return `Connect ${interaction.payload.serviceName}`;
  }

  const count = interaction.payload.questions.length;
  if (interaction.status === "answered") {
    return count === 1 ? "Answered 1 question" : `Answered ${count} questions`;
  }
  if (interaction.status === "cancelled") {
    return count === 1 ? "Cancelled 1 question" : `Cancelled ${count} questions`;
  }
  if (interaction.status === "expired") {
    if (interaction.result?.expirationReason === "superseded_by_comment") {
      return count === 1 ? "Question expired after comment" : "Questions expired after comment";
    }
    return count === 1 ? "Question expired" : "Questions expired";
  }
  return count === 1 ? "Asked 1 question" : `Asked ${count} questions`;
}

/** Readable model input for a durable answer delivered into a successor run. */
export function buildAnsweredQuestionsDeliveryText(
  interaction: AskUserQuestionsInteraction,
): string {
  const questionSet = interaction.payload.questionSet;
  const legacyQuestionById = new Map(
    interaction.payload.questions.map((question) => [question.id, question] as const),
  );
  const canonicalQuestionById = new Map(
    (questionSet?.questions ?? []).map((question) => [question.id, question] as const),
  );
  const lines = (interaction.result?.answers ?? []).map((answer) => {
    const canonical = canonicalQuestionById.get(answer.questionId);
    const legacy = legacyQuestionById.get(answer.questionId);
    const optionLabels = new Map(
      (canonical?.options ?? legacy?.options ?? []).map((option) => [option.id, option.label] as const),
    );
    const values = answer.optionIds.map((optionId) => optionLabels.get(optionId) ?? optionId);
    if (answer.otherText?.trim()) values.push(answer.otherText.trim());
    const prompt = canonical?.prompt ?? legacy?.prompt ?? answer.questionId;
    const label = canonical?.header && canonical.header !== prompt
      ? `${canonical.header} — ${prompt}`
      : prompt;
    return `- ${label}: ${values.join(", ") || "No answer"}`;
  });
  return ["Answered questions", ...(lines.length > 0 ? ["", ...lines] : [])].join("\n");
}

export function buildSuggestedTaskTree(
  tasks: readonly SuggestedTaskDraft[],
): SuggestedTaskTreeNode[] {
  const nodes = new Map<string, SuggestedTaskTreeNode>();
  for (const task of tasks) {
    nodes.set(task.clientKey, { task, children: [] });
  }

  const roots: SuggestedTaskTreeNode[] = [];
  for (const task of tasks) {
    const node = nodes.get(task.clientKey);
    if (!node) continue;
    const parentNode = task.parentClientKey ? nodes.get(task.parentClientKey) : null;
    if (parentNode) {
      parentNode.children.push(node);
      continue;
    }
    roots.push(node);
  }

  return roots;
}

export function countSuggestedTaskNodes(node: SuggestedTaskTreeNode): number {
  return 1 + node.children.reduce((sum, child) => sum + countSuggestedTaskNodes(child), 0);
}

export function collectSuggestedTaskClientKeys(node: SuggestedTaskTreeNode): string[] {
  return [
    node.task.clientKey,
    ...node.children.flatMap((child) => collectSuggestedTaskClientKeys(child)),
  ];
}

export function getQuestionAnswerLabels(args: {
  question: AskUserQuestionsQuestion;
  answers: readonly AskUserQuestionsAnswer[];
}) {
  const { question, answers } = args;
  const answer = answers.find((candidate) => candidate.questionId === question.id);
  const selectedIds = answer?.optionIds ?? [];
  const optionLabelById = new Map(
    question.options.map((option) => [option.id, option.label] as const),
  );
  const labels = selectedIds
    .map((optionId) => optionLabelById.get(optionId))
    .filter((label): label is string => typeof label === "string");
  const otherText = answer?.otherText?.trim();
  if (otherText) labels.push(`Other: ${otherText}`);
  return labels;
}

/** The author's advice for one question, as both question surfaces render it. */
export interface QuestionRecommendationAdvice {
  /** Option the author recommends. Never preselected: the responder chooses. */
  optionId: string;
  optionLabel: string;
  /** Explicit explanation shown beside the options, when the author supplied one. */
  rationale: string | null;
  /** True when the question asks for a consequential decision. */
  isDecision: boolean;
}

/** A decision question records one prepared choice a person made. */
export function isDecisionQuestion(question: {
  intent?: "decision" | "information";
}): boolean {
  return question.intent === "decision";
}

/**
 * Recommendation advice for one question, or null when it recommends nothing.
 * Presentation only — the recommended option is never selected for the
 * responder, because an interview is only evidence when they answered it.
 */
export function describeQuestionRecommendation(question: {
  options?: readonly { id: string; label: string; recommended?: boolean }[];
  intent?: "decision" | "information";
  recommendationRationale?: string | null;
}): QuestionRecommendationAdvice | null {
  const recommended = (question.options ?? []).find(
    (option) => option.recommended === true,
  );
  if (!recommended) return null;
  const rationale = question.recommendationRationale?.trim();
  return {
    optionId: recommended.id,
    optionLabel: recommended.label,
    rationale: rationale ? rationale : null,
    isDecision: isDecisionQuestion(question),
  };
}

/**
 * True when a native question asks for a consequential decision, preferring the
 * recovered canonical presentation's intent. Both question surfaces use this so
 * a decision renders the same way whether it was authored natively or projected
 * from a runtime request.
 */
export function isAskUserQuestionDecision(
  interaction: AskUserQuestionsInteraction,
  question: AskUserQuestionsQuestion,
): boolean {
  const canonical = interaction.payload.questionSet?.questions.find(
    (candidate) => candidate.id === question.id,
  );
  return isDecisionQuestion(canonical ?? question);
}

/**
 * Recommendation advice for one native question, preferring the recovered
 * canonical presentation (`payload.questionSet`) because it is the exact
 * provider-neutral contract; the native mirror is the fallback for cards whose
 * payload predates a field.
 */
export function getAskUserQuestionRecommendation(
  interaction: AskUserQuestionsInteraction,
  question: AskUserQuestionsQuestion,
): QuestionRecommendationAdvice | null {
  const canonical = interaction.payload.questionSet?.questions.find(
    (candidate) => candidate.id === question.id,
  );
  return describeQuestionRecommendation({
    options: canonical?.options?.length ? canonical.options : question.options,
    intent: canonical?.intent ?? question.intent,
    recommendationRationale:
      canonical?.recommendationRationale ?? question.recommendationRationale,
  });
}

/**
 * A single `ask_user_questions` question is degenerate when it offers *no way at
 * all* to answer — hiding it therefore strands nothing the user could have
 * resolved. Structural only, no semantic guessing about the wording:
 *
 *  - its `prompt` is empty / whitespace-only, OR
 *  - it presents nothing to respond to: no first-class free-text option (the
 *    PAP-419 `freeText` flag) AND no selectable fixed option.
 *
 * A question with even a single fixed option is answerable (the user selects it
 * and submits), so it is NOT degenerate and must keep rendering — otherwise a
 * hidden-but-pending interaction would strand the assignee waiting on a response
 * that can never arrive. Legitimate shapes all pass: yes/no, multi-select,
 * free-text, and single-option acknowledgements.
 */
function isDegenerateAskUserQuestion(question: AskUserQuestionsQuestion): boolean {
  if (question.prompt.trim().length === 0) return true;
  const hasFreeTextOption = question.options.some((option) => option.freeText === true);
  if (hasFreeTextOption) return false;
  const selectableOptionCount = question.options.filter(
    (option) => option.freeText !== true,
  ).length;
  return selectableOptionCount === 0;
}

/**
 * Structural render guard for `ask_user_questions` cards. A card is degenerate —
 * safe to never draw because it strands nothing the user could resolve — when it
 * offers no answerable question: it has zero questions, OR every question is
 * degenerate (see {@link isDegenerateAskUserQuestion}: blank prompt, or no
 * option and no free-text). A card with any answerable question — including a
 * single fixed option — always renders.
 *
 * UI-only: the interaction is still created and stored server-side (audit
 * intact); callers use this purely to decide whether to draw the card. Returns
 * false for any other interaction kind — the guard is scoped to
 * `ask_user_questions`.
 */
export function isDegenerateAskUserQuestions(
  interaction: IssueThreadInteraction,
): boolean {
  if (interaction.kind !== "ask_user_questions") return false;
  const questions = interaction.payload.questions;
  if (questions.length === 0) return true;
  return questions.every(isDegenerateAskUserQuestion);
}

/**
 * A stale sibling `ask_user_questions` that the server auto-expired when its own
 * creator posted a newer one on the same issue (PAP-437). The replacement card
 * is already in the thread, so this expired shell adds nothing and is never
 * drawn. Gated on `status === "expired"` so a still-pending card is never hidden
 * (PAP-424 / 00b136f45: hiding a pending question would strand the assignee).
 * Distinct from `superseded_by_comment`, which keeps its stale notice.
 */
export function isSupersededByNewerSiblingInteraction(
  interaction: IssueThreadInteraction,
): boolean {
  if (interaction.kind !== "ask_user_questions") return false;
  if (interaction.status !== "expired") return false;
  return interaction.result?.expirationReason === "superseded_by_newer_interaction";
}

/**
 * Single enforcement point for whether an interaction card should be suppressed
 * from every thread surface. Routing all render sites through this one predicate
 * keeps composition backbones and the card in lockstep, so a suppressed card
 * never leaves an empty slot in one place while another still draws it.
 */
export function shouldHideInteractionCard(
  interaction: IssueThreadInteraction,
): boolean {
  return (
    isDegenerateAskUserQuestions(interaction)
    || isSupersededByNewerSiblingInteraction(interaction)
  );
}
