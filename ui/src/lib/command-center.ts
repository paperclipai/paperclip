import type { Agent, Issue, Project } from "@paperclipai/shared";
import type { LiveRunForIssue } from "../api/heartbeats";

export type CommandCenterGateTone = "queued" | "running" | "approval" | "guardrail" | "stale" | "complete";

export interface CommandCenterGate {
  label: string;
  nextAction: string;
  tone: CommandCenterGateTone;
}

export interface CommandCenterLiveRun {
  runId: string;
  agentId: string;
  agentName: string;
  adapterType: string;
  status: string;
  startedAt: string | null;
  elapsedMs: number | null;
  livenessState: LiveRunForIssue["livenessState"];
  nextAction: string | null;
}

export interface CommandCenterSquadRole {
  label: string;
  scope: string;
  internal: boolean;
}

export interface CommandCenterIssueTrace {
  id: string;
  identifier: string;
  projectId: string | null;
  projectName: string;
  projectDisplayLabel: string;
  title: string;
  status: string;
  priority: string;
  responsible: string;
  squadRole: CommandCenterSquadRole | null;
  agentId: string | null;
  gate: CommandCenterGate;
  branchOrWorkspace: string | null;
  updatedAt: Date | string;
  liveRun: CommandCenterLiveRun | null;
}

export interface CommandCenterProjectGroup {
  projectId: string | null;
  projectName: string;
  projectStatus: string | null;
  activeIssueCount: number;
  issues: CommandCenterIssueTrace[];
}

export interface CommandCenterTrace {
  groups: CommandCenterProjectGroup[];
  totalActiveIssues: number;
  reviewGateCount: number;
  guardrailCount: number;
}

export interface BuildCommandCenterTraceInput {
  projects: Project[];
  issues: Issue[];
  agents: Agent[];
}

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled", "backlog"]);
const STALE_GATE_THRESHOLD_MS = 72 * 60 * 60 * 1000;

export const AI_OPS_SQUAD_ROLES: Record<string, CommandCenterSquadRole> = {
  maestro: {
    label: "Maestro",
    scope: "Orchestration, Paperclip, Obsidian, prioritization, and handoff.",
    internal: true,
  },
  dedalo: {
    label: "Dédalo",
    scope: "DelegAI resident execution and app implementation.",
    internal: true,
  },
  polux: {
    label: "Pólux",
    scope: "Continuous JurisX execution.",
    internal: true,
  },
  atena: {
    label: "Atena",
    scope: "Continuous LucrosX execution.",
    internal: true,
  },
  apolo: {
    label: "Apolo",
    scope: "Frontend and UI craft.",
    internal: true,
  },
  ariadne: {
    label: "Ariadne",
    scope: "Product, UX, copy, and acceptance criteria.",
    internal: true,
  },
  arquimedes: {
    label: "Arquimedes",
    scope: "Architecture, technical review, and Paperclip consistency.",
    internal: true,
  },
  sentinela: {
    label: "Sentinela",
    scope: "AppSec, risk, and guardrail validation.",
    internal: true,
  },
  guardiao: {
    label: "External gate",
    scope: "External gate for infra, production, real secrets/DBs, DNS, firewall, and broad permissions.",
    internal: false,
  },
};

function normalizeSquadRoleKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")[0] ?? "";
}

export function resolveCommandCenterSquadRole(agent: Pick<Agent, "name"> | null): CommandCenterSquadRole | null {
  if (!agent?.name) return null;
  return AI_OPS_SQUAD_ROLES[normalizeSquadRoleKey(agent.name)] ?? null;
}

function isQueuedForCommandCenter(issue: Issue): boolean {
  return !issue.executionRunId && !issue.checkoutRunId && issue.status === "todo";
}

function isStaleQueuedIssue(issue: Issue, now = new Date()): boolean {
  if (!isQueuedForCommandCenter(issue)) return false;

  const updatedAt = new Date(issue.updatedAt).getTime();
  if (Number.isNaN(updatedAt)) return false;

  return now.getTime() - updatedAt > STALE_GATE_THRESHOLD_MS;
}

function issueDisplayId(issue: Issue): string {
  return issue.identifier ?? issue.id.slice(0, 8);
}

export function deriveCommandCenterGate(issue: Issue): CommandCenterGate {
  if (issue.status === "blocked") {
    return {
      label: "External guardrail",
      nextAction: "Resolve blocker before allowing more autonomous execution.",
      tone: "guardrail",
    };
  }

  if (issue.status === "in_review") {
    return {
      label: "JP approval gate",
      nextAction: "Review output and approve, request changes, or close the issue.",
      tone: "approval",
    };
  }

  if (issue.executionRunId || issue.checkoutRunId || issue.status === "in_progress") {
    return {
      label: "Agent execution",
      nextAction: "Monitor the active run and capture branch or workspace evidence before review.",
      tone: "running",
    };
  }

  if (isStaleQueuedIssue(issue)) {
    return {
      label: "Stale — needs attention",
      nextAction: "No activity in over 72 hours. Review assignment and priority.",
      tone: "stale",
    };
  }

  if (!issue.assigneeAgentId && !issue.assigneeUserId) {
    return {
      label: "Ownership needed",
      nextAction: "Assign an owner before execution starts.",
      tone: "queued",
    };
  }

  return {
    label: "Ready for execution",
    nextAction: "Start or schedule agent work when JP approves the next move.",
    tone: "queued",
  };
}

export function buildCommandCenterTrace(input: BuildCommandCenterTraceInput): CommandCenterTrace {
  const projectMap = new Map(input.projects.map((project) => [project.id, project]));
  const agentMap = new Map(input.agents.map((agent) => [agent.id, agent]));
  const groups = new Map<string, CommandCenterProjectGroup>();

  const activeIssues = input.issues
    .filter((issue) => !TERMINAL_ISSUE_STATUSES.has(issue.status))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  for (const issue of activeIssues) {
    const project = issue.projectId ? projectMap.get(issue.projectId) ?? null : null;
    const groupKey = project?.id ?? "__unscoped__";
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        projectId: project?.id ?? null,
        projectName: project?.name ?? "Unscoped work",
        projectStatus: project?.status ?? null,
        activeIssueCount: 0,
        issues: [],
      };
      groups.set(groupKey, group);
    }

    const agent = issue.assigneeAgentId ? agentMap.get(issue.assigneeAgentId) ?? null : null;
    const branchOrWorkspace = issue.executionWorkspacePreference
      ?? issue.executionWorkspaceId
      ?? issue.projectWorkspaceId
      ?? null;
    group.issues.push({
      id: issue.id,
      identifier: issueDisplayId(issue),
      projectId: project?.id ?? null,
      projectName: group.projectName,
      projectDisplayLabel: `${group.projectName} · ${issueDisplayId(issue)}`,
      title: issue.title,
      status: issue.status,
      priority: issue.priority,
      responsible: agent?.name ?? (issue.assigneeUserId ? "Board operator" : "Unassigned"),
      squadRole: resolveCommandCenterSquadRole(agent),
      agentId: agent?.id ?? null,
      gate: deriveCommandCenterGate(issue),
      branchOrWorkspace,
      updatedAt: issue.updatedAt,
      liveRun: null,
    });
    group.activeIssueCount += 1;
  }

  const sortedGroups = [...groups.values()].sort((a, b) => {
    if (a.projectId === null && b.projectId !== null) return 1;
    if (a.projectId !== null && b.projectId === null) return -1;
    return a.projectName.localeCompare(b.projectName);
  });

  return {
    groups: sortedGroups,
    totalActiveIssues: activeIssues.length,
    reviewGateCount: activeIssues.filter((issue) => issue.status === "in_review").length,
    guardrailCount: activeIssues.filter((issue) => issue.status === "blocked").length,
  };
}

const LIVE_RUN_STATUSES = new Set(["queued", "running"]);

function buildLiveRunEntry(run: LiveRunForIssue, now: Date): CommandCenterLiveRun {
  const startedMs = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const elapsedMs = startedMs && !Number.isNaN(startedMs) ? now.getTime() - startedMs : null;
  return {
    runId: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    adapterType: run.adapterType,
    status: run.status,
    startedAt: run.startedAt,
    elapsedMs,
    livenessState: run.livenessState,
    nextAction: run.nextAction ?? null,
  };
}

export function enrichCommandCenterWithLiveRuns(
  trace: CommandCenterTrace,
  liveRuns: readonly LiveRunForIssue[],
  now = new Date(),
): CommandCenterTrace {
  const activeByIssue = new Map<string, LiveRunForIssue>();
  for (const run of liveRuns) {
    if (!run.issueId || !LIVE_RUN_STATUSES.has(run.status)) continue;
    const existing = activeByIssue.get(run.issueId);
    if (!existing || run.createdAt > existing.createdAt) {
      activeByIssue.set(run.issueId, run);
    }
  }

  if (activeByIssue.size === 0) return trace;

  return {
    ...trace,
    groups: trace.groups.map((group) => ({
      ...group,
      issues: group.issues.map((issueTrace) => {
        const run = activeByIssue.get(issueTrace.id);
        if (!run) return issueTrace;
        return { ...issueTrace, liveRun: buildLiveRunEntry(run, now) };
      }),
    })),
  };
}
