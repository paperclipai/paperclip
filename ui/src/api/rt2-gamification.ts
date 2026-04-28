import type {
  Rt2Leaderboard,
  Rt2AgentScore,
  Rt2AchievementsSummary,
  Rt2TokenBalance,
  Rt2CostBreakdown,
  Rt2XpTransaction,
  Rt2LevelHistoryEntry,
  Rt2AgentBalance,
} from "@paperclipai/shared";
import { api } from "./client";

// Helper to build URL with query params (api.get doesn't support params object)
function buildUrl(
  path: string,
  params?: Record<string, string | number | undefined>,
): string {
  if (!params) return path;
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, String(value));
    }
  }
  const queryString = searchParams.toString();
  return queryString ? `${path}?${queryString}` : path;
}

export const rt2GamificationApi = {
  // Leaderboard
  getLeaderboard: (companyId: string, projectId?: string) =>
    api.get<Rt2Leaderboard>(
      buildUrl(`/companies/${companyId}/rt2/gamification/leaderboard`, {
        projectId,
      }),
    ),

  // Agent Score
  getAgentScore: (companyId: string, agentId: string) =>
    api.get<Rt2AgentScore>(
      `/companies/${companyId}/rt2/gamification/agents/${agentId}/score`,
    ),

  // Achievements
  getAchievements: (companyId: string, agentId: string) =>
    api.get<Rt2AchievementsSummary>(
      `/companies/${companyId}/rt2/gamification/agents/${agentId}/achievements`,
    ),

  // XP History
  getXpHistory: (companyId: string, agentId: string, limit = 50) =>
    api.get<Rt2XpTransaction[]>(
      buildUrl(
        `/companies/${companyId}/rt2/gamification/agents/${agentId}/xp-history`,
        { limit },
      ),
    ),

  // Level History
  getLevelHistory: (companyId: string, agentId: string) =>
    api.get<Rt2LevelHistoryEntry[]>(
      `/companies/${companyId}/rt2/gamification/agents/${agentId}/level-history`,
    ),

  // Agent Gold Balance
  getAgentBalance: (companyId: string, agentId: string) =>
    api.get<Rt2AgentBalance>(
      `/companies/${companyId}/rt2/gamification/agents/${agentId}/balance`,
    ),

  // Economy
  getTokenBalance: (companyId: string) =>
    api.get<Rt2TokenBalance>(`/companies/${companyId}/rt2/economy/balance`),

  getCostBreakdown: (companyId: string) =>
    api.get<Rt2CostBreakdown>(`/companies/${companyId}/rt2/economy/costs`),

  // Award XP (for internal use)
  awardXp: (
    companyId: string,
    agentId: string,
    activityType: string,
    issueId?: string,
    description?: string,
  ) =>
    api.post(`/companies/${companyId}/rt2/gamification/award-xp`, {
      agentId,
      activityType,
      issueId,
      description,
    }),

  // Award Gold (for internal use)
  awardGold: (
    companyId: string,
    agentId: string,
    amount: number,
    description?: string,
  ) =>
    api.post(`/companies/${companyId}/rt2/gamification/award-gold`, {
      agentId,
      amount,
      description,
    }),
};
