import type { Goal, Project } from "@paperclipai/shared";

export const ONBOARDING_PROJECT_NAME = "Onboarding";
export const ONBOARDING_CEO_HIRE_IDEMPOTENCY_KEY = "onboarding:founding-ceo:v1";

export const DEFAULT_ONBOARDING_TASK_TITLE =
  "Design and staff this company's operating harness";

export const DEFAULT_ONBOARDING_TASK_DESCRIPTION = `You are the founding CEO. Your first job is to design and staff the smallest complete operating harness for this company, not to hire one fixed role by name.

1. Read the company mission, goals, current roster, and existing capabilities before proposing hires.
2. Define the capability lanes this company actually needs. Cover company/product coordination, implementation and operations, independent verification, and deployment/recovery or domain specialists when the mission requires them.
3. Reuse capable existing agents. For missing lanes, request company-scoped hires through the normal approval flow. Do not duplicate roles or copy agents, configuration, credentials, or secrets from another company.
4. Keep useful planning moving while hire approvals are pending. Do not create agents or work merely to fill a template.
5. Delegate execution with explicit contracts, acceptance checks, required evidence/work products, blockers, and a typed escalation path. Do not mark work done until its declared evidence exists.

Deliver a roster gap assessment, the proposed operating harness, hire requests for missing capabilities, the first prioritized execution lanes, and the evidence/escalation policy the team will follow.`;

export function buildOnboardingCeoHirePayload(input: {
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
}) {
  return {
    ...input,
    role: "ceo" as const,
    idempotencyKey: ONBOARDING_CEO_HIRE_IDEMPOTENCY_KEY,
  };
}

function buildOperatingHarnessExecutionContract() {
  return {
    schemaVersion: 2,
    contractType: "delegated_task",
    taskType: "company_operating_harness_bootstrap",
    core: {
      objective:
        "Design and staff the smallest complete operating harness for this company's actual mission and workload.",
      why:
        "The company needs a durable, company-scoped capability and escalation design before execution is delegated.",
      sourceOfTruth: {
        sources: [
          "current company mission and goals",
          "current company issues and workload",
          "current company roster, reporting lines, skills, access, and pending approvals",
        ],
      },
      constraints: [
        "Reuse capable in-company agents and pending hires before proposing new headcount.",
        "Do not copy agents, configuration, credentials, or secrets from another company.",
        "Keep useful planning and unblocked work moving while approvals are pending.",
      ],
      acceptanceChecks: [
        "A durable operating-harness assessment maps real capability demand to current or pending coverage and verified access.",
        "Every remaining capability gap has the smallest justified governed hire or configuration action, without fixed role names or headcount.",
        "Initial execution lanes define acceptance evidence, independent review where required, and a typed escalation path.",
        "The assessment is registered as a qualifying document work product on this issue.",
      ],
      requiredOutputs: [{ workProductType: "document" as const }],
      handoffNotes: {
        managerReasoning:
          "This first CEO assignment establishes the reusable control harness that prevents routine routing and recovery decisions from returning to the board.",
        nextAction:
          "Inspect current company state, publish and register the assessment document, then submit only the missing company-scoped hires and executable lanes.",
      },
    },
  };
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

export function buildOnboardingProjectPayload(goalId: string | null) {
  return {
    name: ONBOARDING_PROJECT_NAME,
    status: "in_progress" as const,
    ...(goalId ? { goalIds: [goalId] } : {}),
  };
}

export function selectReusableOnboardingProject<T extends Pick<Project, "name" | "status">>(
  projects: T[],
): T | null {
  return (
    projects.find(
      (project) =>
        project.status !== "cancelled" &&
        project.name.trim().toLowerCase() === ONBOARDING_PROJECT_NAME.toLowerCase(),
    ) ?? null
  );
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
  const isDefaultOperatingHarnessMandate =
    title === DEFAULT_ONBOARDING_TASK_TITLE &&
    description === DEFAULT_ONBOARDING_TASK_DESCRIPTION;

  return {
    title,
    ...(description ? { description } : {}),
    assigneeAgentId: input.assigneeAgentId,
    projectId: input.projectId,
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(isDefaultOperatingHarnessMandate
      ? { executionContract: buildOperatingHarnessExecutionContract() }
      : {}),
    status: "todo" as const,
    // Marks the single onboarding first task so the server seeds an agent
    // greeting and the task-detail view suppresses the seeded-description bubble.
    onboardingFirstTask: true,
  };
}
