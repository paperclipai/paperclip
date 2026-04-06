import type { Goal } from "@paperclipai/shared";
import type { WorkspaceScanResult } from "../api/workspace";

export const ONBOARDING_PROJECT_NAME = "Onboarding";

export const DEFAULT_TASK_TITLE = "Hire your first engineer and create a hiring plan";

export const DEFAULT_TASK_DESCRIPTION = `You are the CEO. You set the direction for the company.

- hire a founding engineer
- write a hiring plan
- break the roadmap into concrete tasks and start delegating work`;

export function buildContextualTaskDescription(
  scan: WorkspaceScanResult | null,
): { title: string; description: string } {
  if (!scan) {
    return { title: DEFAULT_TASK_TITLE, description: DEFAULT_TASK_DESCRIPTION };
  }

  const projectLabel = scan.projectName ?? "this project";
  const langLabel = scan.languages.length > 0
    ? ` (${scan.languages.join(", ")})`
    : "";

  const lines: string[] = [
    `You are the CEO. Your team is working on **${projectLabel}**${langLabel}.`,
    "",
    `The workspace is at \`${scan.cwd}\`.`,
  ];

  if (scan.configFiles.length > 0) {
    lines.push(`Key files: ${scan.configFiles.join(", ")}.`);
  }

  if (scan.readmeExcerpt) {
    const excerpt = scan.readmeExcerpt.length > 500
      ? scan.readmeExcerpt.slice(0, 500) + "..."
      : scan.readmeExcerpt;
    lines.push("", "Project overview:", excerpt);
  }

  lines.push(
    "",
    "- Review the codebase and create an initial technical assessment",
    "- Break the roadmap into concrete tasks based on the actual code",
    "- Delegate work to your team",
  );

  const title = scan.projectName
    ? `Review ${scan.projectName} and create a technical roadmap`
    : "Review the codebase and create a technical roadmap";

  return { title, description: lines.join("\n") };
}

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

export function buildCeoTriageTask(issueCount: number, hasCto: boolean) {
  return {
    title: "Triage and delegate imported issues",
    description: `${issueCount} issues were imported from Linear during onboarding.

- Review each issue and determine the right department
- ${hasCto ? "Delegate technical issues to the CTO — they will assign to engineers" : "Hire a CTO and delegate technical issues to them"}
- Assign marketing/growth issues to the CMO (or hire one)
- Delegate everything else using your best judgment
- Follow up on any blockers or stale work`,
  };
}

export function buildCtoKickoffTask(issueCount: number) {
  return {
    title: "Review technical issues and assign to engineers",
    description: `${issueCount} issues were imported from Linear. The CEO will delegate technical issues to you.

- Review each assigned issue for clarity and scope
- Break large issues into subtasks if needed
- Assign work to engineers on your team (hire if needed)
- Prioritize based on dependencies and impact
- Flag any blockers or unclear requirements back to the CEO`,
  };
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
