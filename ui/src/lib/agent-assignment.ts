import {
  agentAssignmentProfileSchema,
  type AgentAssignmentProfile,
  type AssignmentScore,
  type AssignmentScoreKey,
  type AssignmentStrategy,
  type IssueAssignmentRouting,
} from "@paperclipai/shared";

export const ASSIGNMENT_STRATEGY_LABELS: Record<AssignmentStrategy, string> = {
  balanced: "Balanced",
  cost: "Cost",
  quality: "Quality",
  speed: "Speed",
};

export const ASSIGNMENT_SCORE_LABELS: Record<AssignmentScoreKey, string> = {
  quota: "Quota",
  cost: "Cost",
  load: "Load",
  health: "Health",
  quality: "Quality",
};

const MAX_AGENT_CAPABILITIES = 32;
const MAX_CAPABILITY_LENGTH = 64;

export function readAutoAssignmentDraft(value: unknown): AgentAssignmentProfile {
  const parsed = agentAssignmentProfileSchema.safeParse(value);
  return parsed.success ? parsed.data : { enabled: false, capabilities: [] };
}

/** Splits comma-separated tags the same way the server stores them: trimmed, lowercase, no duplicates. */
export function parseCapabilityTags(text: string, max = MAX_AGENT_CAPABILITIES): string[] {
  const tags: string[] = [];
  for (const raw of text.split(",")) {
    const tag = raw.trim().toLowerCase();
    if (!tag || tag.length > MAX_CAPABILITY_LENGTH || tags.includes(tag)) continue;
    tags.push(tag);
    if (tags.length >= max) break;
  }
  return tags;
}

function sameAutoAssignment(a: AgentAssignmentProfile, b: AgentAssignmentProfile): boolean {
  return a.enabled === b.enabled && a.quality === b.quality
    && a.capabilities.length === b.capabilities.length && a.capabilities.every((tag, index) => b.capabilities[index] === tag);
}

export function runtimeConfigWithAutoAssignment(
  saved: Record<string, unknown>,
  draft: Record<string, unknown> | undefined,
  next: AgentAssignmentProfile,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...saved, ...draft, aiConnection: (draft ?? saved).aiConnection };
  const value: AgentAssignmentProfile = { enabled: next.enabled, capabilities: next.capabilities };
  if (next.quality !== undefined) value.quality = next.quality;
  if (!sameAutoAssignment(readAutoAssignmentDraft(saved.autoAssignment), value)) merged.autoAssignment = value;
  else if ("autoAssignment" in saved) merged.autoAssignment = saved.autoAssignment;
  else delete merged.autoAssignment;
  return merged;
}

/** Statuses the server accepts for automatic assignment. */
const AUTO_ASSIGNABLE_STATUSES = new Set(["backlog", "todo", "blocked"]);

export function canAutoAssignIssue(issue: { assigneeAgentId: string | null; assigneeUserId: string | null; status: string }): boolean {
  return !issue.assigneeAgentId && !issue.assigneeUserId && AUTO_ASSIGNABLE_STATUSES.has(issue.status);
}

export function assignmentCandidateName(routing: IssueAssignmentRouting, agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  return routing.candidates.find((candidate) => candidate.agentId === agentId)?.name ?? null;
}

export function formatIssueAssignmentRouting(routing: IssueAssignmentRouting | null | undefined): string {
  if (!routing) return "Auto-assign";
  const strategy = ASSIGNMENT_STRATEGY_LABELS[routing.strategy];
  if (routing.status === "no_candidate") return `Auto: no match · ${strategy}`;
  return `Auto: ${assignmentCandidateName(routing, routing.selectedAgentId) ?? "unknown agent"} · ${strategy}`;
}

/** An `unknown` signal is a neutral placeholder, so it says so instead of looking like a measured value. */
export function formatAssignmentScore(score: AssignmentScore): string {
  const value = score.value.toFixed(2);
  return score.source === "unknown" ? `unknown (neutral ${value})` : `${value} · ${score.source}`;
}
