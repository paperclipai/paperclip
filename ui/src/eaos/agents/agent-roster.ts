// LET-484 working-product slice — backend-backed `/eaos/agents` roster.
//
// This module derives a compact, truthful roster summary from the canonical
// Agent records returned by `agentsApi.list`. No live actions, no fake fields:
// every row mirrors a backend field, and rollups are derived in pure JS so
// tests can assert them without a network mock.

import { AGENT_ROLE_LABELS, type AgentRole, type AgentStatus } from "@paperclipai/shared";
import type { Agent } from "@paperclipai/shared";
import type { EaosStateLabel } from "../state-labels";

export type AgentRosterStatusBucket = "active" | "running" | "idle" | "paused" | "error" | "pending_approval" | "terminated";

export interface AgentRosterCounts {
  readonly total: number;
  readonly active: number;
  readonly running: number;
  readonly idle: number;
  readonly paused: number;
  readonly error: number;
  readonly pendingApproval: number;
  readonly terminated: number;
}

export interface AgentRosterRow {
  readonly id: string;
  readonly name: string;
  readonly urlKey: string;
  readonly role: AgentRole;
  readonly roleLabel: string;
  readonly title: string | null;
  readonly status: AgentStatus;
  readonly statusChipLabel: EaosStateLabel;
  readonly adapterType: string;
  readonly lastHeartbeatAt: Date | null;
  readonly pausedAt: Date | null;
  readonly pauseReason: string | null;
  readonly budgetMonthlyCents: number;
  readonly spentMonthlyCents: number;
  readonly kernelRoute: string;
}

export interface AgentRosterGroup {
  readonly role: AgentRole;
  readonly roleLabel: string;
  readonly rows: readonly AgentRosterRow[];
}

// Order roles roughly leadership → execution → support so the operator scan
// matches the chain-of-command top-down read. Unknown roles fall through to
// the end alphabetically.
const ROLE_ORDER: readonly AgentRole[] = [
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "security",
  "pm",
  "engineer",
  "designer",
  "qa",
  "devops",
  "researcher",
  "general",
];

const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set(["active", "idle", "running"]);

function statusChipLabel(status: AgentStatus): EaosStateLabel {
  switch (status) {
    case "running":
      return "LIVE";
    case "active":
    case "idle":
      return "BACKEND-BACKED";
    case "pending_approval":
      return "APPROVAL REQUIRED";
    case "paused":
      return "PREVIEW";
    case "error":
      return "FAILED";
    case "terminated":
      return "DEMO";
    default:
      return "PREVIEW";
  }
}

function toDate(value: Agent["lastHeartbeatAt"] | Agent["pausedAt"]): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value as unknown as string);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function buildAgentRosterRow(agent: Agent): AgentRosterRow {
  const role = agent.role;
  return {
    id: agent.id,
    name: agent.name,
    urlKey: agent.urlKey,
    role,
    roleLabel: AGENT_ROLE_LABELS[role] ?? role,
    title: agent.title,
    status: agent.status,
    statusChipLabel: statusChipLabel(agent.status),
    adapterType: agent.adapterType,
    lastHeartbeatAt: toDate(agent.lastHeartbeatAt),
    pausedAt: toDate(agent.pausedAt),
    pauseReason: agent.pauseReason,
    budgetMonthlyCents: agent.budgetMonthlyCents,
    spentMonthlyCents: agent.spentMonthlyCents,
    kernelRoute: `/agents/${encodeURIComponent(agent.id)}`,
  };
}

export function summarizeAgents(agents: readonly Agent[]): AgentRosterCounts {
  const counts: AgentRosterCounts = {
    total: agents.length,
    active: 0,
    running: 0,
    idle: 0,
    paused: 0,
    error: 0,
    pendingApproval: 0,
    terminated: 0,
  };
  const mutable = counts as { -readonly [K in keyof AgentRosterCounts]: AgentRosterCounts[K] };
  for (const agent of agents) {
    if (ACTIVE_STATUSES.has(agent.status)) mutable.active += 1;
    switch (agent.status) {
      case "running":
        mutable.running += 1;
        break;
      case "idle":
        mutable.idle += 1;
        break;
      case "paused":
        mutable.paused += 1;
        break;
      case "error":
        mutable.error += 1;
        break;
      case "pending_approval":
        mutable.pendingApproval += 1;
        break;
      case "terminated":
        mutable.terminated += 1;
        break;
      default:
        break;
    }
  }
  return mutable;
}

export function groupRosterByRole(rows: readonly AgentRosterRow[]): readonly AgentRosterGroup[] {
  const byRole = new Map<AgentRole, AgentRosterRow[]>();
  for (const row of rows) {
    const bucket = byRole.get(row.role) ?? [];
    bucket.push(row);
    byRole.set(row.role, bucket);
  }
  const ordered: AgentRosterGroup[] = [];
  for (const role of ROLE_ORDER) {
    const bucket = byRole.get(role);
    if (bucket && bucket.length > 0) {
      ordered.push({
        role,
        roleLabel: AGENT_ROLE_LABELS[role] ?? role,
        rows: bucket.slice().sort(compareRow),
      });
      byRole.delete(role);
    }
  }
  for (const [role, bucket] of byRole.entries()) {
    ordered.push({
      role,
      roleLabel: AGENT_ROLE_LABELS[role] ?? role,
      rows: bucket.slice().sort(compareRow),
    });
  }
  return ordered;
}

function compareRow(a: AgentRosterRow, b: AgentRosterRow): number {
  // Terminated rows sink to the bottom inside a role group.
  if (a.status === "terminated" && b.status !== "terminated") return 1;
  if (b.status === "terminated" && a.status !== "terminated") return -1;
  return a.name.localeCompare(b.name);
}

// Test-only helpers — exported so the vitest suite can lock the rollups
// without depending on JSX.
export const AGENT_ROSTER_TEST_HELPERS = {
  ROLE_ORDER,
  ACTIVE_STATUSES,
  statusChipLabel,
  toDate,
};
