import type { Agent, Issue } from "@paperclipai/shared";
import { createIssue, storybookAgents, storybookAuthSession, storybookCompanies } from "../../fixtures/paperclipData";

export const workloadAgentIds = {
  mira: "agent-workload-trial-mira",
  atlas: "agent-workload-trial-atlas",
  sage: "agent-workload-trial-sage",
  quinn: "agent-workload-trial-quinn",
  rowan: "agent-workload-trial-rowan",
  ember: "agent-workload-trial-ember",
} as const;

const companyId = storybookCompanies[0]!.id;
const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000);

function agent(id: string, name: string, title: string, status: Agent["status"], role: Agent["role"] = "engineer"): Agent {
  return {
    ...storybookAgents[0]!, id, companyId, name, title, role,
    urlKey: id, status, reportsTo: null,
    capabilities: title, adapterConfig: {}, runtimeConfig: {},
    budgetMonthlyCents: 50_000, spentMonthlyCents: 0,
    lastHeartbeatAt: status === "paused" ? ago(180) : ago(3),
    pauseReason: status === "paused" ? "manual" : null,
    pausedAt: status === "paused" ? ago(180) : null,
    metadata: null, createdAt: ago(10_080), updatedAt: ago(3),
  };
}

export const workloadAgents: Agent[] = [
  agent(workloadAgentIds.mira, "Mira", "Product engineer", "running"),
  agent(workloadAgentIds.atlas, "Atlas — International Infrastructure and Reliability", "Infrastructure engineer", "running"),
  agent(workloadAgentIds.sage, "Sage", "Research analyst", "idle", "researcher"),
  agent(workloadAgentIds.quinn, "Quinn", "Quality engineer", "idle", "qa"),
  agent(workloadAgentIds.rowan, "Rowan", "Content strategist", "paused", "general"),
  agent(workloadAgentIds.ember, "Ember", "Release engineer", "running"),
];

function task(number: number, assigneeAgentId: string, title: string, status: Issue["status"], minutesAgo: number): Issue {
  const updatedAt = ago(minutesAgo);
  return createIssue({
    id: `agent-workload-trial-task-${number}`, companyId, assigneeAgentId,
    assigneeUserId: null, responsibleUserId: storybookAuthSession.user.id,
    identifier: `PAP-${number}`, issueNumber: number, title,
    description: `Synthetic workload example: ${title}.`, status, priority: "medium",
    projectId: null, projectWorkspaceId: null, project: null,
    goalId: null, goal: null, parentId: null,
    createdByUserId: storybookAuthSession.user.id, createdByAgentId: null,
    checkoutRunId: null, executionRunId: null, executionAgentNameKey: null, executionLockedAt: null,
    executionWorkspaceId: null, executionWorkspacePreference: null, currentExecutionWorkspace: null,
    labelIds: [], labels: [], blockedBy: [], blocks: [], billingCode: null,
    isUnreadForMe: false, myLastTouchAt: updatedAt, lastExternalCommentAt: null,
    lastActivityAt: updatedAt, startedAt: status === "todo" || status === "backlog" ? null : ago(1_440),
    completedAt: status === "done" ? updatedAt : null,
    createdAt: ago(4_320), updatedAt,
  });
}

export const workloadTasks: Issue[] = [
  task(801, workloadAgentIds.mira, "Simplify the first-run workspace setup", "in_progress", 2),
  task(802, workloadAgentIds.mira, "Resolve overlapping invitation states when a workspace owner retries an expired invitation", "in_progress", 7),
  task(803, workloadAgentIds.mira, "Add setup guidance to the welcome checklist", "todo", 18),
  task(804, workloadAgentIds.mira, "Explore a reusable workspace starter", "backlog", 190),
  task(805, workloadAgentIds.mira, "Review the onboarding copy with customer success", "in_review", 12),
  task(806, workloadAgentIds.mira, "Ship the invitation confirmation screen", "done", 55),
  task(807, workloadAgentIds.mira, "Clarify ownership of the activation milestone", "blocked", 105),
  task(808, workloadAgentIds.atlas, "Investigate intermittent replication lag across the international billing infrastructure before the next regional rollout", "in_progress", 3),
  task(809, workloadAgentIds.atlas, "Prepare region-aware health checks", "in_progress", 9),
  task(810, workloadAgentIds.atlas, "Document the failover rehearsal", "todo", 28),
  task(811, workloadAgentIds.atlas, "Add regional latency budgets", "todo", 76),
  task(812, workloadAgentIds.atlas, "Investigate read-replica capacity planning", "backlog", 220),
  task(813, workloadAgentIds.atlas, "Review the EU rollout checklist", "in_review", 31),
  task(814, workloadAgentIds.atlas, "Replace expired staging certificates", "done", 150),
  task(815, workloadAgentIds.sage, "Summarize customer interviews for the planning review", "done", 40),
  task(816, workloadAgentIds.sage, "Publish the competitor onboarding comparison", "done", 215),
  task(817, workloadAgentIds.sage, "Validate the research brief with product", "in_review", 95),
  task(818, workloadAgentIds.rowan, "Draft launch messaging for the partner pilot", "todo", 185),
  task(819, workloadAgentIds.rowan, "Prepare customer-story interview questions", "backlog", 260),
  task(820, workloadAgentIds.rowan, "Get approval for the revised campaign brief", "blocked", 181),
  task(821, workloadAgentIds.rowan, "Publish the product update digest", "done", 330),
  task(822, workloadAgentIds.ember, "Verify the release candidate against the smoke checklist", "in_progress", 5),
  task(823, workloadAgentIds.ember, "Prepare the rollback rehearsal", "todo", 66),
  task(824, workloadAgentIds.ember, "Review dependency updates for the release", "done", 130),
];
