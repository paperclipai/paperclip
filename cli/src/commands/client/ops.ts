import { Command } from "commander";
import type { Agent, Company, DashboardSummary, Issue, Project } from "@paperclipai/shared";
import {
  addCommonClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
  type BaseClientOptions,
} from "./common.js";

const ACTIVE_ISSUE_STATUSES = ["blocked", "in_progress", "in_review", "todo", "backlog"] as const;
const PROJECT_STATUS_RANK: Record<string, number> = {
  in_progress: 0,
  planned: 1,
  backlog: 2,
  completed: 3,
  cancelled: 4,
};
const AGENT_STATUS_RANK: Record<string, number> = {
  running: 0,
  active: 1,
  idle: 2,
  pending_approval: 3,
  paused: 4,
  error: 5,
  terminated: 6,
};

interface OpsSummaryOptions extends BaseClientOptions {
  companyId?: string;
  limit?: string;
}

interface OpsFocusProject {
  id: string;
  urlKey: string;
  name: string;
  status: string;
  leadAgentId: string | null;
  primaryWorkspace: string | null;
}

interface OpsFocusIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  project: string | null;
  assigneeAgentId: string | null;
}

interface OpsFocusAgent {
  id: string;
  urlKey: string;
  name: string;
  role: string;
  status: string;
  adapterType: string;
  spentMonthlyCents: number;
}

export interface OpsSummary {
  profileName: string;
  company: {
    id: string;
    name: string;
    status: string;
    issuePrefix: string;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  agents: {
    counts: DashboardSummary["agents"];
    focus: OpsFocusAgent[];
  };
  tasks: {
    counts: DashboardSummary["tasks"];
    pendingApprovals: number;
    staleTasks: number;
    focus: OpsFocusIssue[];
  };
  projects: {
    total: number;
    withPrimaryWorkspace: number;
    byStatus: Record<string, number>;
    focus: OpsFocusProject[];
  };
}

function parseLimit(value: string | undefined): number {
  if (!value?.trim()) return 3;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("--limit must be a positive number");
  }
  return Math.min(10, Math.floor(parsed));
}

function countByStatus<T extends { status: string }>(rows: T[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {});
}

function primaryWorkspaceLabel(project: Project): string | null {
  const workspace = project.primaryWorkspace;
  if (!workspace) return null;
  return workspace.cwd ?? workspace.repoUrl ?? workspace.name;
}

function compareByRankThenName(
  left: { status: string; name?: string | null; title?: string | null },
  right: { status: string; name?: string | null; title?: string | null },
  rankMap: Record<string, number>,
): number {
  const rankDiff = (rankMap[left.status] ?? 99) - (rankMap[right.status] ?? 99);
  if (rankDiff !== 0) return rankDiff;
  const leftName = (left.name ?? left.title ?? "").toLowerCase();
  const rightName = (right.name ?? right.title ?? "").toLowerCase();
  return leftName.localeCompare(rightName);
}

function toMoney(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function buildOpsSummary(input: {
  profileName: string;
  company: Company;
  dashboard: DashboardSummary;
  projects: Project[];
  agents: Agent[];
  activeIssues: Issue[];
  limit: number;
}): OpsSummary {
  const focusProjects = [...input.projects]
    .sort((a, b) => compareByRankThenName(a, b, PROJECT_STATUS_RANK))
    .slice(0, input.limit)
    .map((project) => ({
      id: project.id,
      urlKey: project.urlKey,
      name: project.name,
      status: project.status,
      leadAgentId: project.leadAgentId,
      primaryWorkspace: primaryWorkspaceLabel(project),
    }));

  const focusIssues = [...input.activeIssues].slice(0, input.limit).map((issue) => ({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    priority: issue.priority,
    project: issue.project?.urlKey ?? issue.project?.name ?? issue.projectId,
    assigneeAgentId: issue.assigneeAgentId,
  }));

  const focusAgents = [...input.agents]
    .filter((agent) => agent.status !== "terminated")
    .sort((a, b) => compareByRankThenName(a, b, AGENT_STATUS_RANK))
    .slice(0, input.limit)
    .map((agent) => ({
      id: agent.id,
      urlKey: agent.urlKey,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      adapterType: agent.adapterType,
      spentMonthlyCents: agent.spentMonthlyCents,
    }));

  return {
    profileName: input.profileName,
    company: {
      id: input.company.id,
      name: input.company.name,
      status: input.company.status,
      issuePrefix: input.company.issuePrefix,
    },
    costs: {
      monthSpendCents: input.dashboard.costs.monthSpendCents,
      monthBudgetCents: input.dashboard.costs.monthBudgetCents,
      monthUtilizationPercent: input.dashboard.costs.monthUtilizationPercent,
    },
    agents: {
      counts: input.dashboard.agents,
      focus: focusAgents,
    },
    tasks: {
      counts: input.dashboard.tasks,
      pendingApprovals: input.dashboard.pendingApprovals,
      staleTasks: input.dashboard.staleTasks,
      focus: focusIssues,
    },
    projects: {
      total: input.projects.length,
      withPrimaryWorkspace: input.projects.filter((project) => Boolean(project.primaryWorkspace)).length,
      byStatus: countByStatus(input.projects),
      focus: focusProjects,
    },
  };
}

export function renderOpsSummary(summary: OpsSummary): string {
  const lines = [
    `Company: ${summary.company.name} [${summary.company.status}] prefix=${summary.company.issuePrefix} profile=${summary.profileName}`,
    `Costs: ${toMoney(summary.costs.monthSpendCents)} / ${toMoney(summary.costs.monthBudgetCents)} (${summary.costs.monthUtilizationPercent.toFixed(1)}%)`,
    `Agents: active=${summary.agents.counts.active} running=${summary.agents.counts.running} paused=${summary.agents.counts.paused} error=${summary.agents.counts.error}`,
    `Tasks: open=${summary.tasks.counts.open} in_progress=${summary.tasks.counts.inProgress} blocked=${summary.tasks.counts.blocked} done=${summary.tasks.counts.done} pending_approvals=${summary.tasks.pendingApprovals} stale=${summary.tasks.staleTasks}`,
    `Projects: total=${summary.projects.total} workspace_coverage=${summary.projects.withPrimaryWorkspace}/${summary.projects.total || 0}`,
  ];

  const statusParts = Object.entries(summary.projects.byStatus)
    .sort(([left], [right]) => (PROJECT_STATUS_RANK[left] ?? 99) - (PROJECT_STATUS_RANK[right] ?? 99))
    .map(([status, count]) => `${status}=${count}`);
  if (statusParts.length > 0) {
    lines.push(`Project status mix: ${statusParts.join(" ")}`);
  }

  lines.push("Focus projects:");
  if (summary.projects.focus.length === 0) {
    lines.push("- none");
  } else {
    for (const project of summary.projects.focus) {
      lines.push(
        `- ${project.urlKey} [${project.status}] lead=${project.leadAgentId ?? "-"} workspace=${project.primaryWorkspace ?? "-"}`,
      );
    }
  }

  lines.push("Focus issues:");
  if (summary.tasks.focus.length === 0) {
    lines.push("- none active");
  } else {
    for (const issue of summary.tasks.focus) {
      lines.push(
        `- ${(issue.identifier ?? issue.id)} [${issue.priority}/${issue.status}] ${issue.title} project=${issue.project ?? "-"} assignee=${issue.assigneeAgentId ?? "-"}`,
      );
    }
  }

  lines.push("Focus agents:");
  if (summary.agents.focus.length === 0) {
    lines.push("- none");
  } else {
    for (const agent of summary.agents.focus) {
      lines.push(
        `- ${agent.name} [${agent.role}/${agent.status}] adapter=${agent.adapterType} spend=${toMoney(agent.spentMonthlyCents)}`,
      );
    }
  }

  return lines.join("\n");
}

export function registerOpsCommands(program: Command): void {
  const ops = program.command("ops").description("Operator summary commands");

  addCommonClientOptions(
    ops
      .command("summary")
      .description("Compact one-company operator summary")
      .option("--limit <count>", "Max number of focus rows to show per section", "3")
      .action(async (opts: OpsSummaryOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const limit = parseLimit(opts.limit);
          const issueParams = new URLSearchParams({ status: ACTIVE_ISSUE_STATUSES.join(",") });

          const [company, dashboard, projects, agents, activeIssues] = await Promise.all([
            ctx.api.get<Company>(`/api/companies/${ctx.companyId}`),
            ctx.api.get<DashboardSummary>(`/api/companies/${ctx.companyId}/dashboard`),
            ctx.api.get<Project[]>(`/api/companies/${ctx.companyId}/projects`),
            ctx.api.get<Agent[]>(`/api/companies/${ctx.companyId}/agents`),
            ctx.api.get<Issue[]>(`/api/companies/${ctx.companyId}/issues?${issueParams.toString()}`),
          ]);

          if (!company || !dashboard) {
            throw new Error("Unable to load company summary data.");
          }

          const summary = buildOpsSummary({
            profileName: ctx.profileName,
            company,
            dashboard,
            projects: projects ?? [],
            agents: agents ?? [],
            activeIssues: activeIssues ?? [],
            limit,
          });

          if (ctx.json) {
            printOutput(summary, { json: true });
            return;
          }

          console.log(renderOpsSummary(summary));
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: true },
  );
}
