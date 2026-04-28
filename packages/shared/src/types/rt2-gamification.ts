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
