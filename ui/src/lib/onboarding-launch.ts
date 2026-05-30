import type { Goal, UpsertIssueDocument } from "@paperclipai/shared";
import { ONBOARDING_STARTER_CONTEXT_DOCUMENT_KEY as SHARED_ONBOARDING_STARTER_CONTEXT_DOCUMENT_KEY } from "@paperclipai/shared";
import type { HltUseCaseCatalogItem } from "./hlt-use-case-catalog";

export const ONBOARDING_PROJECT_NAME = "Onboarding";

function goalCreatedAt(goal: Goal) {
  const createdAt = goal.createdAt instanceof Date ? goal.createdAt : new Date(goal.createdAt);
  return Number.isNaN(createdAt.getTime()) ? 0 : createdAt.getTime();
}

function pickEarliestGoal(goals: Goal[]) {
  return [...goals].sort((a, b) => goalCreatedAt(a) - goalCreatedAt(b))[0] ?? null;
}

export function selectDefaultCompanyGoalId(goals: Goal[]): string | null {
  const companyGoals = goals.filter((goal) => goal.level === "company");
  const rootGoals = companyGoals.filter((goal) => !goal.parentId);
  const activeRootGoals = rootGoals.filter((goal) => goal.status === "active");

  return (
    pickEarliestGoal(activeRootGoals)?.id ??
    pickEarliestGoal(rootGoals)?.id ??
    pickEarliestGoal(companyGoals)?.id ??
    null
  );
}

export function buildOnboardingProjectPayload(goalId: string | null) {
  return {
    name: ONBOARDING_PROJECT_NAME,
    status: "in_progress" as const,
    ...(goalId ? { goalIds: [goalId] } : {}),
  };
}

export function buildOnboardingIssuePayload(input: {
  title: string;
  description: string;
  assigneeAgentId: string;
  projectId: string;
  goalId: string | null;
}) {
  const title = input.title.trim();
  const description = input.description.trim();

  return {
    title,
    ...(description ? { description } : {}),
    assigneeAgentId: input.assigneeAgentId,
    projectId: input.projectId,
    ...(input.goalId ? { goalId: input.goalId } : {}),
    status: "todo" as const,
  };
}

export function buildOnboardingUseCaseContextDocument(useCase: HltUseCaseCatalogItem): {
  key: typeof SHARED_ONBOARDING_STARTER_CONTEXT_DOCUMENT_KEY;
  payload: UpsertIssueDocument;
} {
  const metadata = {
    useCaseId: useCase.id,
    label: useCase.label,
    teamRoles: useCase.teamRoles,
    optionalRefs: useCase.optionalKatailystRefs,
    approvalBoundary: useCase.approvalBoundary ?? null,
    fallbackBehavior: useCase.fallbackBehavior,
  };

  return {
    key: SHARED_ONBOARDING_STARTER_CONTEXT_DOCUMENT_KEY,
    payload: {
      title: "Starter context",
      format: "markdown",
      changeSummary: "Attach selected onboarding starter context",
      body: [
        "# Starter context",
        "",
        "This document stores the selected onboarding starter so future context providers can enrich the issue without changing the operator-facing task copy.",
        "",
        `- Use case: ${useCase.label}`,
        `- Use case id: ${useCase.id}`,
        `- Team roles: ${useCase.teamRoles.join(", ")}`,
        useCase.approvalBoundary ? `- Approval boundary: ${useCase.approvalBoundary}` : null,
        `- Fallback behavior: ${useCase.fallbackBehavior}`,
        "",
        "```json",
        JSON.stringify(metadata, null, 2),
        "```",
      ].filter((line): line is string => line !== null).join("\n"),
    },
  };
}
