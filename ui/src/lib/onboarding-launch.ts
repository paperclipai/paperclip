import type { Goal } from "@paperclipai/shared";
import type { WorkspaceScanResult } from "../api/workspace";

export const ONBOARDING_PROJECT_NAME = "Onboarding";

export const DEFAULT_TASK_TITLE = "Review the backlog and ask the board what to prioritize";

export const DEFAULT_TASK_DESCRIPTION = `You are the CEO — a planning and coordination agent. The board (human users) sets strategy; you organize and execute.

**Your deliverable: an approval request that the board can act on.**

1. Review the current backlog — read the issues, understand what exists
2. Create an approval via \`POST /api/companies/{companyId}/approvals\` with type \`approve_ceo_strategy\`:
   - \`payload.plan\`: your analysis of the backlog + specific questions for the board (e.g., "Which area should we focus on first?", "Are any of these outdated?", "Should we hire agents for X?")
   - \`payload.nextStepsIfApproved\`: what you will do once the board gives direction
   - \`payload.nextStepsIfRejected\`: how you will adjust
   - Link this issue using the \`issueIds\` field
3. The board will see your approval in the Approvals dashboard and respond with direction
4. Wait for board approval before delegating or starting any work`;

function buildProjectContextBlock(scan: WorkspaceScanResult, budgetChars: number): string {
  const sections: string[] = [];

  // Core info — always included
  sections.push(`**Workspace:** \`${scan.cwd}\``);
  if (scan.projectDescription) {
    sections.push(`**Description:** ${scan.projectDescription}`);
  }
  if (scan.frameworks.length > 0) {
    sections.push(`**Tech stack:** ${scan.frameworks.join(", ")}`);
  } else if (scan.languages.length > 0) {
    sections.push(`**Languages:** ${scan.languages.join(", ")}`);
  }
  if (scan.isMonorepo && scan.monorepoPackages.length > 0) {
    sections.push(`**Monorepo packages:** ${scan.monorepoPackages.join(", ")}`);
  }
  if (scan.scripts.length > 0) {
    sections.push(`**Scripts:** ${scan.scripts.join(", ")}`);
  }
  if (scan.configFiles.length > 0) {
    sections.push(`**Config files:** ${scan.configFiles.join(", ")}`);
  }
  if (scan.gitRemoteUrl) {
    sections.push(`**Git:** ${scan.gitRemoteUrl} (${scan.gitDefaultBranch ?? "unknown branch"})`);
  }

  let block = sections.join("\n");

  // CLAUDE.md excerpt — highest value, gets priority budget
  if (scan.claudeMdExcerpt) {
    const claudeBudget = Math.min(1000, budgetChars - block.length - 100);
    if (claudeBudget > 200) {
      const excerpt = scan.claudeMdExcerpt.length > claudeBudget
        ? scan.claudeMdExcerpt.slice(0, claudeBudget) + "\n..."
        : scan.claudeMdExcerpt;
      block += `\n\n**Project guidelines (from CLAUDE.md):**\n${excerpt}`;
    }
  }

  // README excerpt — fills remaining budget
  if (scan.readmeExcerpt) {
    const remaining = budgetChars - block.length - 50;
    if (remaining > 200) {
      const readmeBudget = Math.min(800, remaining);
      const excerpt = scan.readmeExcerpt.length > readmeBudget
        ? scan.readmeExcerpt.slice(0, readmeBudget) + "\n..."
        : scan.readmeExcerpt;
      block += `\n\n**README overview:**\n${excerpt}`;
    }
  }

  // Source structure — only if space remains
  if (scan.srcStructure.length > 0) {
    const remaining = budgetChars - block.length - 50;
    if (remaining > 100) {
      const dirs = scan.srcStructure.slice(0, 10).join(", ");
      block += `\n**Key directories:** ${dirs}`;
    }
  }

  return block;
}

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
    `You are the CEO — a planning and coordination agent. Your team is working on **${projectLabel}**${langLabel}.`,
    "",
    "## Project Context",
    buildProjectContextBlock(scan, 2500),
    "",
    "**Your deliverable: an approval request that the board can act on.**",
    "",
    "1. Review the backlog and codebase — understand what exists",
    "2. Create an approval via `POST /api/companies/{companyId}/approvals` with type `approve_ceo_strategy`:",
    "   - `payload.plan`: your analysis + specific questions for the board (e.g., \"Which area should we focus on first?\", \"Are any of these outdated?\", \"Should we hire agents for X?\")",
    "   - `payload.nextStepsIfApproved`: what you will do once the board gives direction",
    "   - `payload.nextStepsIfRejected`: how you will adjust",
    "   - Link this issue using the `issueIds` field",
    "3. The board will see your approval in the Approvals dashboard and respond with direction",
    "4. Wait for board approval before delegating or starting any work",
  ];

  const title = scan.projectName
    ? `Review ${scan.projectName} and ask the board what to prioritize`
    : "Review the backlog and ask the board what to prioritize";

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

export function buildCeoTriageTask(issueCount: number, hasCto: boolean, scan?: WorkspaceScanResult | null) {
  const contextBlock = scan ? `\n\n## Project Context\n${buildProjectContextBlock(scan, 1500)}\n` : "";

  return {
    title: "Review imported issues and ask the board what to prioritize",
    description: `${issueCount} issues were imported from Linear during onboarding.${contextBlock}

**Your deliverable: an approval request that the board can act on.**

1. Review the imported issues — categorize by area (infra, platform, marketing, etc.)
2. Create an approval via \`POST /api/companies/{companyId}/approvals\` with type \`approve_ceo_strategy\`:
   - \`payload.plan\`: your categorized summary of the ${issueCount} issues + specific questions for the board (e.g., "Which area should we focus on first?", "Are any outdated?", "Should we hire agents for specific areas?")
   - \`payload.nextStepsIfApproved\`: what you will do once the board gives direction
   - \`payload.nextStepsIfRejected\`: how you will adjust
   - Link this issue using the \`issueIds\` field
3. The board will see your approval in the Approvals dashboard and respond with direction
4. Wait for board approval before delegating or starting any work`,
  };
}

export function buildCtoKickoffTask(issueCount: number, scan?: WorkspaceScanResult | null) {
  const projectLabel = scan?.projectName ?? "the project";
  const langLabel = scan?.languages.length ? ` (${scan.languages.join(", ")})` : "";
  const contextBlock = scan ? `\n\n## Technical Context\n${buildProjectContextBlock(scan, 2000)}\n` : "";

  return {
    title: scan?.projectName
      ? `Review ${scan.projectName} technical issues and ask the board what to prioritize`
      : "Review technical issues and ask the board what to prioritize",
    description: `You are the CTO — the technical lead for **${projectLabel}**${langLabel}. ${issueCount} issues were imported from Linear. The CEO will delegate technical issues to you.${contextBlock}

**Your first job is to understand the technical backlog, then create an approval so the board can give you direction.**

1. Review each assigned issue for clarity, scope, and feasibility
2. Do NOT start work or create new issues without board approval
3. **Create an approval immediately** via \`POST /api/companies/{companyId}/approvals\` with type \`approve_ceo_strategy\`:
   - In \`payload.plan\`: your technical assessment + specific questions for the board about priorities, scope, and sequencing
   - In \`payload.nextStepsIfApproved\`: what you will do once the board gives direction
   - In \`payload.nextStepsIfRejected\`: how you will adjust
   - Link this issue using the \`issueIds\` field
4. The board will see your approval in the Approvals dashboard and respond with direction
5. Wait for board approval before assigning work or hiring engineers
6. Flag blockers or unclear requirements to the CEO immediately`,
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
