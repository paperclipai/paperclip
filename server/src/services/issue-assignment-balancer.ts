import {
  assignmentCapacityTargetForStatus,
  evaluateAssignmentCapacity,
  type AssignmentCapacityLimits,
} from "./issue-assignment-capacity.js";

const DEFAULT_ROLE_FIT_WEIGHT = 40;
const DEFAULT_CAPACITY_HEADROOM_WEIGHT = 30;
const DEFAULT_PROJECT_FAMILIARITY_WEIGHT = 10;
const DEFAULT_FAIRNESS_ROTATION_WEIGHT = 10;
const DEFAULT_CRITICAL_OVERLOAD_PENALTY = 25;
const DEFAULT_STALE_BLOCK_PENALTY = 10;
const DEFAULT_CRITICAL_CAP = 3;
const DEFAULT_STALE_BLOCK_THRESHOLD = 2;
const DEFAULT_EXCLUDE_ROLES = ["ceo"];

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const normalized = Math.floor(parsed);
  return normalized > 0 ? normalized : fallback;
}

function parseRoleList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

function normalizeRole(role: string | null | undefined) {
  return (role ?? "").trim().toLowerCase();
}

function normalizeRoleSet(roles: string[] | null | undefined) {
  if (!roles || roles.length === 0) return new Set<string>();
  return new Set(roles.map((role) => role.trim().toLowerCase()).filter((role) => role.length > 0));
}

function normalizeHeadroom(headroom: number | null | undefined) {
  if (headroom == null) return 2;
  return Math.max(0, Math.floor(headroom));
}

function toIsoOrNull(value: Date | null) {
  return value ? value.toISOString() : null;
}

export interface AssignmentBalancerConfig {
  enabled: boolean;
  shadowMode: boolean;
  criticalCapPerAgent: number;
  staleBlockThreshold: number;
  roleFitWeight: number;
  capacityHeadroomWeight: number;
  projectFamiliarityWeight: number;
  fairnessRotationWeight: number;
  criticalOverloadPenalty: number;
  staleBlockPenalty: number;
  excludeRoles: string[];
}

export interface AssignmentBalancerCandidateInput {
  agentId: string;
  agentName: string;
  role: string | null;
  counts: {
    running: number;
    queued: number;
    criticalOpen: number;
    blocked: number;
  };
  limits: AssignmentCapacityLimits;
  projectFamiliarityCount: number;
  lastAssignedAt: Date | null;
}

export interface RankedAssignmentCandidate {
  agentId: string;
  agentName: string;
  role: string | null;
  score: number;
  reason: string;
  criticalOpenCount: number;
  blockedOpenCount: number;
  counts: {
    running: number;
    queued: number;
  };
  available: {
    running: number | null;
    queued: number | null;
    combinedHeadroom: number;
  };
  lastAssignedAt: string | null;
}

export interface AssignmentBalancerDecision {
  mode: "disabled" | "shadow" | "auto";
  selectedAgentId: string | null;
  selectedAgentName: string | null;
  candidatesEvaluated: number;
  topCandidates: RankedAssignmentCandidate[];
  excludedCandidates: Array<{ agentId: string; reason: string }>;
}

export function resolveAssignmentBalancerConfigFromEnv(): AssignmentBalancerConfig {
  return {
    enabled: parseBooleanEnv(process.env.PAPERCLIP_ASSIGN_BALANCER_ENABLED, true),
    shadowMode: parseBooleanEnv(process.env.PAPERCLIP_ASSIGN_BALANCER_SHADOW_MODE, false),
    criticalCapPerAgent: parsePositiveInteger(
      process.env.PAPERCLIP_ASSIGN_BALANCER_CRITICAL_CAP_PER_AGENT,
      DEFAULT_CRITICAL_CAP,
    ),
    staleBlockThreshold: parsePositiveInteger(
      process.env.PAPERCLIP_ASSIGN_BALANCER_STALE_BLOCK_THRESHOLD,
      DEFAULT_STALE_BLOCK_THRESHOLD,
    ),
    roleFitWeight: parsePositiveInteger(
      process.env.PAPERCLIP_ASSIGN_BALANCER_ROLE_FIT_WEIGHT,
      DEFAULT_ROLE_FIT_WEIGHT,
    ),
    capacityHeadroomWeight: parsePositiveInteger(
      process.env.PAPERCLIP_ASSIGN_BALANCER_CAPACITY_HEADROOM_WEIGHT,
      DEFAULT_CAPACITY_HEADROOM_WEIGHT,
    ),
    projectFamiliarityWeight: parsePositiveInteger(
      process.env.PAPERCLIP_ASSIGN_BALANCER_PROJECT_FAMILIARITY_WEIGHT,
      DEFAULT_PROJECT_FAMILIARITY_WEIGHT,
    ),
    fairnessRotationWeight: parsePositiveInteger(
      process.env.PAPERCLIP_ASSIGN_BALANCER_FAIRNESS_ROTATION_WEIGHT,
      DEFAULT_FAIRNESS_ROTATION_WEIGHT,
    ),
    criticalOverloadPenalty: parsePositiveInteger(
      process.env.PAPERCLIP_ASSIGN_BALANCER_CRITICAL_OVERLOAD_PENALTY,
      DEFAULT_CRITICAL_OVERLOAD_PENALTY,
    ),
    staleBlockPenalty: parsePositiveInteger(
      process.env.PAPERCLIP_ASSIGN_BALANCER_STALE_BLOCK_PENALTY,
      DEFAULT_STALE_BLOCK_PENALTY,
    ),
    excludeRoles: parseRoleList(
      process.env.PAPERCLIP_ASSIGN_BALANCER_EXCLUDE_ROLES,
      DEFAULT_EXCLUDE_ROLES,
    ),
  };
}

type WorkingCandidate = AssignmentBalancerCandidateInput & {
  roleKey: string;
  availableRunning: number | null;
  availableQueued: number | null;
  combinedHeadroom: number;
  fairnessScore: number;
};

function compareByTieBreakers(a: WorkingCandidate, b: WorkingCandidate) {
  if (a.counts.criticalOpen !== b.counts.criticalOpen) {
    return a.counts.criticalOpen - b.counts.criticalOpen;
  }
  const aTime = a.lastAssignedAt ? a.lastAssignedAt.getTime() : Number.MIN_SAFE_INTEGER;
  const bTime = b.lastAssignedAt ? b.lastAssignedAt.getTime() : Number.MIN_SAFE_INTEGER;
  if (aTime !== bTime) return aTime - bTime;
  return a.agentId.localeCompare(b.agentId);
}

export function rankAssignmentCandidates(input: {
  candidates: AssignmentBalancerCandidateInput[];
  targetStatus: string | null | undefined;
  priority: string | null | undefined;
  projectId: string | null | undefined;
  preferredRoles?: string[] | null;
  excludeRoles?: string[] | null;
  config: AssignmentBalancerConfig;
}): AssignmentBalancerDecision {
  if (!input.config.enabled) {
    return {
      mode: "disabled",
      selectedAgentId: null,
      selectedAgentName: null,
      candidatesEvaluated: 0,
      topCandidates: [],
      excludedCandidates: [],
    };
  }

  const target = assignmentCapacityTargetForStatus(input.targetStatus ?? null);
  const preferredRoles = normalizeRoleSet(input.preferredRoles ?? []);
  const includePreferred = preferredRoles.size > 0;
  const excludedRoles = normalizeRoleSet(input.excludeRoles ?? input.config.excludeRoles);
  const excludedCandidates: Array<{ agentId: string; reason: string }> = [];

  const eligible: WorkingCandidate[] = [];
  for (const candidate of input.candidates) {
    const roleKey = normalizeRole(candidate.role);
    if (excludedRoles.has(roleKey)) {
      excludedCandidates.push({ agentId: candidate.agentId, reason: "excluded_role" });
      continue;
    }

    const violation = evaluateAssignmentCapacity({
      target,
      counts: { running: candidate.counts.running, queued: candidate.counts.queued },
      limits: candidate.limits,
    });
    if (violation) {
      excludedCandidates.push({
        agentId: candidate.agentId,
        reason: `capacity_${violation.reason}`,
      });
      continue;
    }

    const availableRunning =
      candidate.limits.maxRunning == null ? null : Math.max(0, candidate.limits.maxRunning - candidate.counts.running);
    const availableQueued =
      candidate.limits.maxQueued == null ? null : Math.max(0, candidate.limits.maxQueued - candidate.counts.queued);
    const combinedHeadroom = normalizeHeadroom(availableRunning) + normalizeHeadroom(availableQueued);

    eligible.push({
      ...candidate,
      roleKey,
      availableRunning,
      availableQueued,
      combinedHeadroom,
      fairnessScore: 0,
    });
  }

  if (eligible.length === 0) {
    return {
      mode: input.config.shadowMode ? "shadow" : "auto",
      selectedAgentId: null,
      selectedAgentName: null,
      candidatesEvaluated: 0,
      topCandidates: [],
      excludedCandidates,
    };
  }

  const sortedForFairness = [...eligible].sort((a, b) => {
    const aTime = a.lastAssignedAt ? a.lastAssignedAt.getTime() : Number.MIN_SAFE_INTEGER;
    const bTime = b.lastAssignedAt ? b.lastAssignedAt.getTime() : Number.MIN_SAFE_INTEGER;
    if (aTime !== bTime) return aTime - bTime;
    return a.agentId.localeCompare(b.agentId);
  });
  const fairnessDenominator = Math.max(1, sortedForFairness.length - 1);
  sortedForFairness.forEach((candidate, idx) => {
    const score =
      sortedForFairness.length === 1
        ? input.config.fairnessRotationWeight
        : Math.round(((fairnessDenominator - idx) / fairnessDenominator) * input.config.fairnessRotationWeight);
    candidate.fairnessScore = score;
  });

  const maxHeadroom = Math.max(1, ...eligible.map((candidate) => candidate.combinedHeadroom));
  const maxProjectFamiliarity = Math.max(1, ...eligible.map((candidate) => candidate.projectFamiliarityCount));
  const hasPreferredRoleMatch =
    includePreferred && eligible.some((candidate) => preferredRoles.has(candidate.roleKey));
  const hasCriticalAlternatives =
    input.priority === "critical" &&
    eligible.some((candidate) => candidate.counts.criticalOpen < input.config.criticalCapPerAgent);

  const ranked = eligible.map((candidate) => {
    const roleFitPoints =
      includePreferred && hasPreferredRoleMatch
        ? preferredRoles.has(candidate.roleKey)
          ? input.config.roleFitWeight
          : 0
        : Math.round(input.config.roleFitWeight / 2);
    const headroomPoints = Math.round((candidate.combinedHeadroom / maxHeadroom) * input.config.capacityHeadroomWeight);
    const projectPoints =
      input.projectId && candidate.projectFamiliarityCount > 0
        ? Math.round((candidate.projectFamiliarityCount / maxProjectFamiliarity) * input.config.projectFamiliarityWeight)
        : 0;
    const criticalPenalty =
      input.priority === "critical" && candidate.counts.criticalOpen >= input.config.criticalCapPerAgent
        ? input.config.criticalOverloadPenalty
        : 0;
    const staleBlockPenalty =
      candidate.counts.blocked >= input.config.staleBlockThreshold ? input.config.staleBlockPenalty : 0;

    const score =
      roleFitPoints +
      headroomPoints +
      projectPoints +
      candidate.fairnessScore -
      criticalPenalty -
      staleBlockPenalty;

    const reasons: string[] = [];
    if (roleFitPoints > 0) reasons.push("role_fit");
    if (headroomPoints > 0) reasons.push("capacity_headroom");
    if (projectPoints > 0) reasons.push("project_familiarity");
    if (candidate.fairnessScore > 0) reasons.push("fairness_rotation");
    if (criticalPenalty > 0) reasons.push("critical_overload_penalty");
    if (staleBlockPenalty > 0) reasons.push("stale_block_penalty");

    return {
      candidate,
      score,
      reason: reasons.join("+") || "baseline",
    };
  });

  const selectionPool =
    hasCriticalAlternatives && input.priority === "critical"
      ? ranked.filter((entry) => entry.candidate.counts.criticalOpen < input.config.criticalCapPerAgent)
      : ranked;

  selectionPool.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return compareByTieBreakers(a.candidate, b.candidate);
  });

  const selected = selectionPool[0] ?? null;
  const topCandidates = selectionPool.slice(0, 3).map((entry) => ({
    agentId: entry.candidate.agentId,
    agentName: entry.candidate.agentName,
    role: entry.candidate.role,
    score: entry.score,
    reason: entry.reason,
    criticalOpenCount: entry.candidate.counts.criticalOpen,
    blockedOpenCount: entry.candidate.counts.blocked,
    counts: {
      running: entry.candidate.counts.running,
      queued: entry.candidate.counts.queued,
    },
    available: {
      running: entry.candidate.availableRunning,
      queued: entry.candidate.availableQueued,
      combinedHeadroom: entry.candidate.combinedHeadroom,
    },
    lastAssignedAt: toIsoOrNull(entry.candidate.lastAssignedAt),
  }));

  return {
    mode: input.config.shadowMode ? "shadow" : "auto",
    selectedAgentId: selected?.candidate.agentId ?? null,
    selectedAgentName: selected?.candidate.agentName ?? null,
    candidatesEvaluated: eligible.length,
    topCandidates,
    excludedCandidates,
  };
}
