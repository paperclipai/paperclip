import type { Goal } from "@paperclipai/shared";
import type { WorkspaceScanResult } from "../api/workspace";

export const ONBOARDING_PROJECT_NAME = "Onboarding";

export const DEFAULT_TASK_TITLE = "Review the backlog and propose a plan for board approval";

export const DEFAULT_TASK_DESCRIPTION = `You are the CEO. The board oversees all major decisions.

**Before starting any work, present a plan to the board for approval.**

- Review the current backlog and company goals
- For each potential initiative, write a brief summary: what it is, why it matters, estimated effort
- Create a formal approval request via \`POST /api/companies/{companyId}/approvals\` with type \`approve_ceo_strategy\` — include your plan in \`payload.plan\`, what happens if approved in \`payload.nextStepsIfApproved\`, and what happens if rejected in \`payload.nextStepsIfRejected\`. Link this issue using the \`issueIds\` field.
- Wait for board approval before delegating or starting any work
- Once approved, break initiatives into tasks and delegate — but request board sign-off on any task that changes scope, architecture, or budget
- Hire agents only after the board approves the hiring plan`;

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
    "**Before starting any work, present a plan to the board for approval.**",
    "",
    "- Review the codebase and create an initial technical assessment",
    "- Create a formal approval request via `POST /api/companies/{companyId}/approvals` with type `approve_ceo_strategy` — include your roadmap in `payload.plan`, what happens if approved in `payload.nextStepsIfApproved`, and what happens if rejected in `payload.nextStepsIfRejected`. Link this issue using the `issueIds` field.",
    "- Wait for board approval before delegating or starting any work",
    "- Once approved, break initiatives into tasks and delegate — but request board sign-off on any task that changes scope, architecture, or budget",
    "- Hire agents only after the board approves the hiring plan",
  );

  const title = scan.projectName
    ? `Review ${scan.projectName} and propose a roadmap for board approval`
    : "Review the codebase and propose a roadmap for board approval";

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
    title: "Triage imported issues and propose a plan for board approval",
    description: `${issueCount} issues were imported from Linear during onboarding.

**Before starting any work, present a triage plan to the board for approval.**

- Review each imported issue and categorize by department and priority
- Create a formal approval request via \`POST /api/companies/{companyId}/approvals\` with type \`approve_ceo_strategy\`. In the payload include:
  - \`plan\`: your triage plan — which issues to pursue, which to defer, and why
  - \`nextStepsIfApproved\`: what you will do immediately (e.g., "Begin hiring Eng Lead and delegating Wave 1 critical issues")
  - \`nextStepsIfRejected\`: how you will adjust (e.g., "Revise triage plan based on board feedback")
  - Link this issue using the \`issueIds\` field so the board sees the full context
- Wait for board approval before delegating or starting any work
- Once approved:
  - ${hasCto ? "Delegate technical issues to the CTO — they will assign to engineers" : "Hire a CTO and delegate technical issues to them"}
  - Assign marketing/growth issues to the CMO (or hire one)
  - Delegate everything else using your best judgment
- For any issue that changes scope or requires significant effort, get board sign-off first
- Hire agents only after the board approves the hiring plan`,
  };
}

export function buildCtoKickoffTask(issueCount: number) {
  return {
    title: "Review technical issues and propose assignments for board approval",
    description: `${issueCount} issues were imported from Linear. The CEO will delegate technical issues to you.

**Before starting any work, present your technical plan to the board for approval.**

- Review each assigned issue for clarity, scope, and feasibility
- Create a formal approval request via \`POST /api/companies/{companyId}/approvals\` with type \`approve_ceo_strategy\` — include your technical plan in \`payload.plan\`, next steps if approved in \`payload.nextStepsIfApproved\`, and next steps if rejected in \`payload.nextStepsIfRejected\`. Link this issue using the \`issueIds\` field.
- Wait for board approval before assigning work or hiring engineers
- Once approved:
  - Break large issues into subtasks
  - Assign work to engineers on your team
  - Prioritize based on dependencies and impact
- For any issue that grows in scope or requires architectural decisions, pause and get board sign-off
- Flag blockers or unclear requirements to the CEO immediately`,
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
  priority?: "critical" | "high" | "medium" | "low";
}) {
  const title = input.title.trim();
  const description = input.description.trim();

  return {
    title,
    ...(description ? { description } : {}),
    assigneeAgentId: input.assigneeAgentId,
    projectId: input.projectId,
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(input.priority ? { priority: input.priority } : {}),
    status: "todo" as const,
  };
}
