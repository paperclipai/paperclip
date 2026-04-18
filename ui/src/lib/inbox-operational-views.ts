import type { Issue } from "@paperclipai/shared";
import type { IssueFilterState } from "./issue-filters";

type AgentOption = {
  id: string;
  name: string;
};

export type InboxOperationalViewDefinition = {
  key: string;
  label: string;
  description: string;
  filterState: IssueFilterState;
};

const MISSION_CONTROL_OWNER_NAMES = ["Main", "Ork", "Stitch", "Personal OS"] as const;
const OPERATIONAL_QUEUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];

function buildOperationalBaseState(hideRoutineExecutions: boolean): IssueFilterState {
  return {
    statuses: [...OPERATIONAL_QUEUE_STATUSES],
    priorities: [],
    owners: [],
    assignees: [],
    creators: [],
    labels: [],
    projects: [],
    workspaces: [],
    needsHumanAttention: false,
    blockedOrWaiting: false,
    recentHandoffs: false,
    hideRoutineExecutions,
  };
}

export function getMissionControlOwnerAgents(agents: AgentOption[] | undefined): AgentOption[] {
  if (!agents?.length) return [];
  const byName = new Map(
    agents.map((agent) => [agent.name.trim().toLowerCase(), agent] as const),
  );
  return MISSION_CONTROL_OWNER_NAMES.flatMap((name) => {
    const matched = byName.get(name.toLowerCase());
    return matched ? [matched] : [];
  });
}

export function filterOperationalQueueIssues(
  issues: Issue[],
  ownerAgents: AgentOption[],
): Issue[] {
  const missionControlOwnerIds = new Set(ownerAgents.map((agent) => agent.id));
  return issues.filter((issue) => {
    if (issue.ownerAgentId && missionControlOwnerIds.has(issue.ownerAgentId)) return true;
    if (issue.missionControl?.needsHumanAttention === true) return true;
    if (issue.missionControl?.handoff != null) return true;
    const workflowStateKind = issue.missionControl?.workflowState?.kind ?? null;
    return workflowStateKind === "waiting_on_human" || workflowStateKind === "blocked_on_upstream";
  });
}

export function buildInboxOperationalViews(
  agents: AgentOption[] | undefined,
  hideRoutineExecutions: boolean,
): InboxOperationalViewDefinition[] {
  const baseState = buildOperationalBaseState(hideRoutineExecutions);
  const ownerAgents = getMissionControlOwnerAgents(agents);

  return [
    {
      key: "operator_queue",
      label: "Operator queue",
      description: "Open mission-control work across the company",
      filterState: baseState,
    },
    ...ownerAgents.map((agent) => ({
      key: `owner:${agent.id}`,
      label: agent.name,
      description: `Open work owned by ${agent.name}`,
      filterState: {
        ...baseState,
        owners: [agent.id],
      },
    })),
    {
      key: "needs_human_attention",
      label: "Needs human",
      description: "Open work explicitly waiting on operator attention",
      filterState: {
        ...baseState,
        needsHumanAttention: true,
      },
    },
    {
      key: "blocked_or_waiting",
      label: "Blocked / waiting",
      description: "Blocked work plus waiting-on-human states",
      filterState: {
        ...baseState,
        blockedOrWaiting: true,
      },
    },
    {
      key: "recent_handoffs",
      label: "Recent handoffs",
      description: "Open work with recent structured handoffs",
      filterState: {
        ...baseState,
        recentHandoffs: true,
      },
    },
  ];
}

function issueFilterArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

function issueFilterStatesEqual(a: IssueFilterState, b: IssueFilterState): boolean {
  return issueFilterArraysEqual(a.statuses, b.statuses)
    && issueFilterArraysEqual(a.priorities, b.priorities)
    && issueFilterArraysEqual(a.owners, b.owners)
    && issueFilterArraysEqual(a.assignees, b.assignees)
    && issueFilterArraysEqual(a.creators, b.creators)
    && issueFilterArraysEqual(a.labels, b.labels)
    && issueFilterArraysEqual(a.projects, b.projects)
    && issueFilterArraysEqual(a.workspaces, b.workspaces)
    && a.needsHumanAttention === b.needsHumanAttention
    && a.blockedOrWaiting === b.blockedOrWaiting
    && a.recentHandoffs === b.recentHandoffs
    && a.hideRoutineExecutions === b.hideRoutineExecutions;
}

export function getActiveInboxOperationalViewKey(
  issueFilters: IssueFilterState,
  views: InboxOperationalViewDefinition[],
): string | null {
  return views.find((view) => issueFilterStatesEqual(issueFilters, view.filterState))?.key ?? null;
}
