export type {
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  AskUserQuestionsPayload,
  AskUserQuestionsQuestion,
  AskUserQuestionsQuestionOption,
  AskUserQuestionsResult,
  IssueThreadInteraction,
  IssueThreadInteractionActorFields,
  IssueThreadInteractionBase,
  IssueThreadInteractionContinuationPolicy,
  IssueThreadInteractionStatus,
  RequestConfirmationInteraction,
  RequestConfirmationIssueDocumentTarget,
  RequestConfirmationPayload,
  RequestConfirmationResult,
  RequestConfirmationTarget,
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
  IssueThreadInteraction,
  RequestConfirmationInteraction,
  SuggestedTaskDraft,
  SuggestTasksInteraction,
  SuggestTasksResultCreatedTask,
} from "@paperclipai/shared";

export interface SuggestedTaskTreeNode {
  task: SuggestedTaskDraft;
  children: SuggestedTaskTreeNode[];
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
    );
}

export function buildIssueThreadInteractionSummary(
  interaction: IssueThreadInteraction,
) {
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
    if (interaction.status === "rejected") return "Declined request";
    if (interaction.status === "expired") {
      const outcome = interaction.result?.outcome;
      if (outcome === "superseded_by_comment") return "Confirmation expired after comment";
      if (outcome === "stale_target") return "Confirmation expired after target changed";
      return "Confirmation expired";
    }
    return "Requested confirmation";
  }

  const count = interaction.payload.questions.length;
  if (interaction.status === "answered") {
    return count === 1 ? "Answered 1 question" : `Answered ${count} questions`;
  }
  return count === 1 ? "Asked 1 question" : `Asked ${count} questions`;
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
  const selectedIds =
    answers.find((answer) => answer.questionId === question.id)?.optionIds ?? [];
  const optionLabelById = new Map(
    question.options.map((option) => [option.id, option.label] as const),
  );
  return selectedIds
    .map((optionId) => optionLabelById.get(optionId))
    .filter((label): label is string => typeof label === "string");
}
