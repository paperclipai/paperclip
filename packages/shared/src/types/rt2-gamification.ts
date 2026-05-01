// =============================================================================
// Rt2 Gamification Types
// XP, Gold, Level, Achievements, Leaderboard
// =============================================================================

// =============================================================================
// XP System
// =============================================================================

export type Rt2XpActivityType =
  | "task_complete"
  | "approval"
  | "wiki_edit"
  | "goal_achieved"
  | "achievement_earned"
  | "streak_bonus";

export interface Rt2XpTransaction {
  id: string;
  companyId: string;
  agentId: string | null;
  issueId: string | null;
  activityType: Rt2XpActivityType;
  xpAmount: number;
  balanceAfter: number;
  description: string | null;
  createdAt: Date;
}

// =============================================================================
// Level System
// =============================================================================

export type Rt2LevelTrigger = "task_complete" | "approval" | "achievement" | "manual";

export interface Rt2LevelHistoryEntry {
  id: string;
  companyId: string;
  agentId: string | null;
  levelBefore: number;
  levelAfter: number;
  xpAtChange: number;
  trigger: Rt2LevelTrigger;
  description: string | null;
  createdAt: Date;
}

// Level calculation: XP needed for level N = N * 100
// e.g., Lv1=100XP, Lv2=200XP, Lv3=300XP
export function calculateLevel(totalXp: number): number {
  if (totalXp <= 0) return 1;
  let level = 1;
  let xpUsed = 0;
  while (xpUsed + level * 100 <= totalXp) {
    xpUsed += level * 100;
    level++;
  }
  return level;
}

export function xpForLevel(level: number): number {
  return level * 100;
}

export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let i = 1; i < level; i++) {
    total += i * 100;
  }
  return total;
}

// =============================================================================
// Achievement System
// =============================================================================

export type Rt2AchievementScope = "agent" | "company";

export interface Rt2AchievementDefinition {
  key: string;
  name: string;
  description: string;
  scope: Rt2AchievementScope;
  icon?: string;
}

export interface Rt2Achievement {
  id: string;
  companyId: string;
  agentId: string | null;
  achievementKey: string;
  scope: Rt2AchievementScope;
  earnedAt: Date | null;
  metadataJson: string | null;
  createdAt: Date;
}

// Predefined achievement keys
export const RT2_ACHIEVEMENT_KEYS = {
  FIRST_TASK: "first_task",
  TEN_TASKS: "ten_tasks",
  FIFTY_TASKS: "fifty_tasks",
  HUNDRED_TASKS: "hundred_tasks",
  FIRST_APPROVAL: "first_approval",
  TEN_APPROVALS: "ten_approvals",
  STREAK_7: "streak_7",
  STREAK_30: "streak_30",
  LEVEL_5: "level_5",
  LEVEL_10: "level_10",
  LEVEL_25: "level_25",
  GOLD_1000: "gold_1000",
  GOLD_10000: "gold_10000",
} as const;

// =============================================================================
// Gold / Economy
// =============================================================================

export interface Rt2AgentBalance {
  id: string;
  companyId: string;
  agentId: string;
  balance: number;
  lifetimeEarned: number;
  lifetimeSpent: number;
  updatedAt: Date;
  createdAt: Date;
}

// =============================================================================
// Leaderboard & Scoring
// =============================================================================

export interface Rt2LeaderboardEntry {
  rank: number;
  agentId: string;
  agentName: string;
  level: number;
  totalXp: number;
  tasksCompleted: number;
  achievementsCount: number;
  goldBalance: number;
}

export interface Rt2Leaderboard {
  companyId: string;
  projectId: string | null;
  entries: Rt2LeaderboardEntry[];
  updatedAt: string;
}

export interface Rt2AgentScore {
  companyId: string;
  agentId: string;
  tasksCompleted: number;
  qualityScore: number;
  collaborationScore: number;
  overallScore: number;
}

// =============================================================================
// CareerMate Progression
// =============================================================================

export type Rt2CareerMateEvidenceStatus = "ready" | "partial" | "missing" | "review_required";
export type Rt2CareerMateTier = "starter" | "builder" | "operator" | "expert" | "principal";
export type Rt2CareerMateReputationBand = "unproven" | "emerging" | "trusted" | "high_trust" | "elite" | "review";
export type Rt2CareerMateAvatarState = "seed" | "builder" | "trusted" | "expert" | "review";

export interface Rt2CareerMateEvidenceLink {
  type: "settlement" | "ledger" | "quality" | "portfolio" | "achievement" | "profile";
  label: string;
  path: string;
}

export interface Rt2CareerProgressionInput {
  companyId: string;
  agentId: string;
  totalXp: number;
  earnedGold: number;
  ledgerEarnedGold: number;
  approvedSettlementGold: number;
  gamificationGoldBalance?: number | null;
  qualityAverage?: number | null;
  qualitySampleCount: number;
  approvedSettlementCount: number;
  rejectedSettlementCount: number;
  flaggedSettlementCount: number;
  highRiskSettlementCount: number;
  portfolioCount: number;
  milestoneCount: number;
  achievementsCount: number;
  sourceLinks?: Rt2CareerMateEvidenceLink[];
}

export interface Rt2CareerProgressionEvidence {
  totalXp: number;
  earnedGold: number;
  ledgerEarnedGold: number;
  approvedSettlementGold: number;
  gamificationGoldBalance: number | null;
  qualityAverage: number | null;
  qualitySampleCount: number;
  approvedSettlementCount: number;
  rejectedSettlementCount: number;
  flaggedSettlementCount: number;
  highRiskSettlementCount: number;
  portfolioCount: number;
  milestoneCount: number;
  achievementsCount: number;
}

export interface Rt2CareerProgression {
  companyId: string;
  agentId: string;
  level: number;
  progressScore: number;
  tier: Rt2CareerMateTier;
  reputationBand: Rt2CareerMateReputationBand;
  avatarState: Rt2CareerMateAvatarState;
  evidenceStatus: Rt2CareerMateEvidenceStatus;
  warnings: string[];
  nextMilestone: {
    tier: Rt2CareerMateTier | null;
    scoreRequired: number | null;
    scoreRemaining: number;
  };
  evidence: Rt2CareerProgressionEvidence;
  sourceLinks: Rt2CareerMateEvidenceLink[];
  calculatedAt: string;
}

const RT2_CAREERMATE_TIER_THRESHOLDS: Array<{ tier: Rt2CareerMateTier; minScore: number }> = [
  { tier: "principal", minScore: 400 },
  { tier: "expert", minScore: 250 },
  { tier: "operator", minScore: 140 },
  { tier: "builder", minScore: 60 },
  { tier: "starter", minScore: 0 },
];

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizeQualityScore(value: number | null | undefined): number {
  if (value == null) return 0;
  if (value > 100) return clampNumber(value / 50, 0, 100);
  return clampNumber(value, 0, 100);
}

function tierForCareerScore(score: number): Rt2CareerMateTier {
  return RT2_CAREERMATE_TIER_THRESHOLDS.find((threshold) => score >= threshold.minScore)?.tier ?? "starter";
}

function nextCareerMilestone(score: number): Rt2CareerProgression["nextMilestone"] {
  const ascending = [...RT2_CAREERMATE_TIER_THRESHOLDS].reverse();
  const next = ascending.find((threshold) => threshold.minScore > score);
  if (!next) {
    return { tier: null, scoreRequired: null, scoreRemaining: 0 };
  }
  return {
    tier: next.tier,
    scoreRequired: next.minScore,
    scoreRemaining: Math.max(0, next.minScore - score),
  };
}

function reputationBandForCareerScore(
  score: number,
  evidenceStatus: Rt2CareerMateEvidenceStatus,
): Rt2CareerMateReputationBand {
  if (evidenceStatus === "review_required") return "review";
  if (score >= 400) return "elite";
  if (score >= 250) return "high_trust";
  if (score >= 140) return "trusted";
  if (score >= 60) return "emerging";
  return "unproven";
}

function avatarStateForCareerScore(
  score: number,
  evidenceStatus: Rt2CareerMateEvidenceStatus,
): Rt2CareerMateAvatarState {
  if (evidenceStatus === "review_required") return "review";
  if (score >= 250) return "expert";
  if (score >= 140) return "trusted";
  if (score >= 60) return "builder";
  return "seed";
}

export function deriveRt2CareerProgression(
  input: Rt2CareerProgressionInput,
  now: Date = new Date(),
): Rt2CareerProgression {
  const qualityAverage = input.qualityAverage == null ? null : normalizeQualityScore(input.qualityAverage);
  const hasPositiveEvidence =
    input.totalXp > 0 ||
    input.earnedGold > 0 ||
    input.ledgerEarnedGold > 0 ||
    input.approvedSettlementGold > 0 ||
    input.qualitySampleCount > 0 ||
    input.approvedSettlementCount > 0 ||
    input.portfolioCount > 0 ||
    input.milestoneCount > 0 ||
    input.achievementsCount > 0;
  const hasReviewEvidence =
    input.rejectedSettlementCount > 0 ||
    input.flaggedSettlementCount > 0 ||
    input.highRiskSettlementCount > 0;
  const hasReadyEvidence =
    input.approvedSettlementCount > 0 &&
    input.ledgerEarnedGold > 0 &&
    input.qualitySampleCount > 0;

  const evidenceStatus: Rt2CareerMateEvidenceStatus = hasReviewEvidence
    ? "review_required"
    : !hasPositiveEvidence
      ? "missing"
      : hasReadyEvidence
        ? "ready"
        : "partial";

  const qualityPoints = qualityAverage == null ? 0 : qualityAverage * 0.8;
  const settlementPoints = clampNumber(input.approvedSettlementGold / 100, 0, 80);
  const ledgerPoints = clampNumber(input.ledgerEarnedGold / 100, 0, 80);
  const xpPoints = clampNumber(input.totalXp / 25, 0, 100);
  const achievementPoints = clampNumber(input.achievementsCount * 6, 0, 72);
  const portfolioPoints = clampNumber(input.portfolioCount * 4 + input.milestoneCount * 6, 0, 48);
  const reviewPenalty =
    input.rejectedSettlementCount * 8 +
    input.flaggedSettlementCount * 10 +
    input.highRiskSettlementCount * 12;
  const progressScore = Math.max(
    0,
    Math.round(
      qualityPoints +
      settlementPoints +
      ledgerPoints +
      xpPoints +
      achievementPoints +
      portfolioPoints -
      reviewPenalty,
    ),
  );

  const tier = tierForCareerScore(progressScore);
  const warnings: string[] = [];
  if (evidenceStatus === "missing") {
    warnings.push("CareerMate progression has no ledger, settlement, quality, or achievement evidence yet.");
  }
  if (evidenceStatus === "partial") {
    warnings.push("CareerMate progression is partial until approved settlement, ledger, and quality evidence all exist.");
  }
  if (input.rejectedSettlementCount > 0) {
    warnings.push("Rejected settlements are visible as governance evidence but do not add progression credit.");
  }
  if (input.flaggedSettlementCount > 0 || input.highRiskSettlementCount > 0) {
    warnings.push("Anti-gaming or high-risk settlement evidence requires review before trust progression is treated as clean.");
  }

  return {
    companyId: input.companyId,
    agentId: input.agentId,
    level: Math.max(1, calculateLevel(input.totalXp) + Math.floor(progressScore / 100)),
    progressScore,
    tier,
    reputationBand: reputationBandForCareerScore(progressScore, evidenceStatus),
    avatarState: avatarStateForCareerScore(progressScore, evidenceStatus),
    evidenceStatus,
    warnings,
    nextMilestone: nextCareerMilestone(progressScore),
    evidence: {
      totalXp: Math.max(0, input.totalXp),
      earnedGold: Math.max(0, input.earnedGold),
      ledgerEarnedGold: Math.max(0, input.ledgerEarnedGold),
      approvedSettlementGold: Math.max(0, input.approvedSettlementGold),
      gamificationGoldBalance: input.gamificationGoldBalance ?? null,
      qualityAverage,
      qualitySampleCount: Math.max(0, input.qualitySampleCount),
      approvedSettlementCount: Math.max(0, input.approvedSettlementCount),
      rejectedSettlementCount: Math.max(0, input.rejectedSettlementCount),
      flaggedSettlementCount: Math.max(0, input.flaggedSettlementCount),
      highRiskSettlementCount: Math.max(0, input.highRiskSettlementCount),
      portfolioCount: Math.max(0, input.portfolioCount),
      milestoneCount: Math.max(0, input.milestoneCount),
      achievementsCount: Math.max(0, input.achievementsCount),
    },
    sourceLinks: input.sourceLinks ?? [],
    calculatedAt: now.toISOString(),
  };
}

// =============================================================================
// Achievements Summary
// =============================================================================

export interface Rt2AchievementsSummary {
  companyId: string;
  agentId: string;
  achievements: Rt2Achievement[];
  unlockedCount: number;
  totalCount: number;
}

// =============================================================================
// Economy / Token Balance
// =============================================================================

export interface Rt2TokenBalance {
  companyId: string;
  balanceCents: number;
  monthlyBudgetCents: number;
  spentThisMonthCents: number;
}

export interface Rt2TransactionHistory {
  companyId: string;
  transactions: Rt2XpTransaction[];
  balance: number;
}

export interface Rt2CostBreakdown {
  companyId: string;
  byAgent: Record<string, number>;
  byProject: Record<string, number>;
  byProvider: Record<string, number>;
  totalCents: number;
}

// =============================================================================
// XP Activity Config
// =============================================================================

export const RT2_XP_REWARDS: Record<Rt2XpActivityType, number> = {
  task_complete: 10,
  approval: 5,
  wiki_edit: 3,
  goal_achieved: 20,
  achievement_earned: 15,
  streak_bonus: 25,
};
