import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  Rt2Leaderboard,
  Rt2AgentScore,
  Rt2AchievementsSummary,
  Rt2TokenBalance,
  Rt2CostBreakdown,
  Rt2XpActivityType,
  Rt2CareerProgression,
} from "@paperclipai/shared";
import { RT2_XP_REWARDS } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { rt2GamificationApi } from "@/api/rt2-gamification";

// =============================================================================
// Utility Functions
// =============================================================================

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toString();
}

function formatTimestamp(date: Date | string | null): string {
  if (!date) return "-";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// =============================================================================
// Activity Type Labels
// =============================================================================

const ACTIVITY_TYPE_LABELS: Record<Rt2XpActivityType, string> = {
  task_complete: "태스크 완료",
  approval: "결재 승인",
  wiki_edit: "위키 편집",
  goal_achieved: "목표 달성",
  achievement_earned: "업적 획득",
  streak_bonus: "연속 보너스",
};

// =============================================================================
// Dashboard Stats
// =============================================================================

function StatCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: "green" | "amber" | "red";
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        highlight === "green"
          ? "border-green-500/30 bg-green-500/5"
          : highlight === "amber"
          ? "border-amber-500/30 bg-amber-500/5"
          : highlight === "red"
          ? "border-red-500/30 bg-red-500/5"
          : "border-border"
      }`}
    >
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`text-2xl font-bold ${
          highlight === "green"
            ? "text-green-600"
            : highlight === "amber"
            ? "text-amber-600"
            : highlight === "red"
            ? "text-red-600"
            : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function careerEvidenceStatusLabel(status: Rt2CareerProgression["evidenceStatus"]): string {
  switch (status) {
    case "ready":
      return "근거 준비됨";
    case "partial":
      return "부분 근거";
    case "review_required":
      return "검토 필요";
    case "missing":
      return "근거 없음";
  }
}

function CareerMateProgressionSection({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId?: string;
}) {
  const { data: progression, isLoading } = useQuery<Rt2CareerProgression>({
    queryKey: ["rt2-career-progression", companyId, agentId],
    queryFn: async () => {
      if (!agentId) throw new Error("No agentId");
      return rt2GamificationApi.getCareerProgression(companyId, agentId);
    },
    enabled: Boolean(companyId) && Boolean(agentId),
  });

  if (!agentId) return null;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold">CareerMate 진행도</h4>
          <p className="mt-0.5 text-xs text-muted-foreground">
            정산, ledger, 품질, XP 근거로 계산합니다.
          </p>
        </div>
        {progression ? (
          <Badge variant={progression.evidenceStatus === "ready" ? "default" : "outline"}>
            {careerEvidenceStatusLabel(progression.evidenceStatus)}
          </Badge>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">로딩 중...</p>
      ) : progression ? (
        <>
          <div className="grid grid-cols-3 gap-2">
            <StatCard label="레벨" value={`Lv.${progression.level}`} />
            <StatCard label="티어" value={progression.tier} />
            <StatCard label="신뢰" value={progression.reputationBand} />
          </div>
          <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
            <div>승인 정산 {progression.evidence.approvedSettlementCount}건 · {formatNumber(progression.evidence.approvedSettlementGold)} Gold</div>
            <div>Ledger 수익 {formatNumber(progression.evidence.ledgerEarnedGold)} Gold</div>
            <div>품질 평균 {progression.evidence.qualityAverage ?? "-"} · 표본 {progression.evidence.qualitySampleCount}개</div>
            <div>XP {formatNumber(progression.evidence.totalXp)} · 업적 {progression.evidence.achievementsCount}개</div>
            <div>포트폴리오 {progression.evidence.portfolioCount}개 · 마일스톤 {progression.evidence.milestoneCount}개</div>
            <div>반려/리스크 {progression.evidence.rejectedSettlementCount + progression.evidence.highRiskSettlementCount}건</div>
          </div>
          {progression.warnings.length > 0 ? (
            <div className="space-y-1 text-xs text-amber-700 dark:text-amber-300">
              {progression.warnings.slice(0, 2).map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2 text-xs">
            <a className="underline underline-offset-4" href="/pnl">정산/P&L</a>
            <a className="underline underline-offset-4" href="/marketplace">Jarvis 마켓</a>
            <a className="underline underline-offset-4" href={`/agents/${agentId}`}>CareerMate 근거</a>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">CareerMate 진행도 근거가 없습니다.</p>
      )}
    </div>
  );
}

// =============================================================================
// Leaderboard Section
// =============================================================================

function LeaderboardEntry({
  entry,
}: {
  entry: {
    rank: number;
    agentId: string;
    agentName: string;
    level: number;
    totalXp: number;
    tasksCompleted: number;
    achievementsCount: number;
    goldBalance: number;
  };
}) {
  const isTop3 = entry.rank <= 3;
  const medal = entry.rank === 1 ? "🥇" : entry.rank === 2 ? "🥈" : entry.rank === 3 ? "🥉" : `#${entry.rank}`;

  return (
    <div
      className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${
        isTop3 ? "border-amber-500/30 bg-amber-500/5" : "border-border"
      }`}
    >
      <div className="flex items-center gap-3">
        <span className="text-lg w-8 text-center">{medal}</span>
        <div>
          <div className="font-medium text-sm">{entry.agentName}</div>
          <div className="text-xs text-muted-foreground">
            Lv.{entry.level} · {entry.tasksCompleted} tasks
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-sm font-medium">{formatNumber(entry.totalXp)} XP</div>
        <div className="text-xs text-muted-foreground">
          🏅 {entry.achievementsCount} · 💰 {formatNumber(entry.goldBalance)}
        </div>
      </div>
    </div>
  );
}

function LeaderboardSection({ companyId }: { companyId: string }) {
  const { data: leaderboard, isLoading } = useQuery<Rt2Leaderboard>({
    queryKey: ["rt2-gamification-leaderboard", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/rt2/gamification/leaderboard`);
      if (!res.ok) throw new Error("Failed to fetch leaderboard");
      return res.json();
    },
    enabled: Boolean(companyId),
  });

  return (
    <div className="space-y-3">
      {isLoading ? (
        <p className="text-sm text-muted-foreground text-center py-4">로딩 중...</p>
      ) : leaderboard && leaderboard.entries.length > 0 ? (
        <div className="space-y-2 max-h-[400px] overflow-y-auto">
          {leaderboard.entries.map((entry) => (
            <LeaderboardEntry key={entry.agentId} entry={entry} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground text-center py-4">
          리더보드 데이터가 없습니다.
        </p>
      )}
    </div>
  );
}

// =============================================================================
// Agent Score Section
// =============================================================================

function AgentScoreCard({ score }: { score: Rt2AgentScore }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="완료 태스크" value={score.tasksCompleted} />
        <StatCard
          label="전체 점수"
          value={score.overallScore.toFixed(1)}
          highlight="green"
        />
        <StatCard label="품질 점수" value={score.qualityScore.toFixed(1)} />
        <StatCard label="협업 점수" value={score.collaborationScore.toFixed(1)} />
      </div>
    </div>
  );
}

// =============================================================================
// Achievements Section
// =============================================================================

function AchievementBadge({
  achievementKey,
  earned,
}: {
  achievementKey: string;
  earned: boolean;
}) {
  const labels: Record<string, string> = {
    first_task: "첫 태스크",
    ten_tasks: "10개 태스크",
    fifty_tasks: "50개 태스크",
    hundred_tasks: "100개 태스크",
    first_approval: "첫 결재",
    ten_approvals: "10개 결재",
    streak_7: "7일 연속",
    streak_30: "30일 연속",
    level_5: "Lv.5 달성",
    level_10: "Lv.10 달성",
    level_25: "Lv.25 달성",
    gold_1000: "💰 1K Gold",
    gold_10000: "💰 10K Gold",
  };

  return (
    <Badge
      variant={earned ? "default" : "outline"}
      className={`text-xs ${!earned ? "opacity-50" : ""}`}
    >
      {labels[achievementKey] || achievementKey}
    </Badge>
  );
}

function AchievementsSection({ companyId, agentId }: { companyId: string; agentId: string }) {
  const { data: summary, isLoading } = useQuery<Rt2AchievementsSummary>({
    queryKey: ["rt2-gamification-achievements", companyId, agentId],
    queryFn: async () => {
      const res = await fetch(
        `/api/companies/${companyId}/rt2/gamification/agents/${agentId}/achievements`
      );
      if (!res.ok) throw new Error("Failed to fetch achievements");
      return res.json();
    },
    enabled: Boolean(companyId) && Boolean(agentId),
  });

  const achievementKeys = [
    "first_task",
    "ten_tasks",
    "fifty_tasks",
    "hundred_tasks",
    "first_approval",
    "ten_approvals",
    "streak_7",
    "streak_30",
    "level_5",
    "level_10",
    "level_25",
    "gold_1000",
    "gold_10000",
  ];

  const earnedKeys = new Set(summary?.achievements.map((a) => a.achievementKey) || []);

  return (
    <div className="space-y-3">
      {isLoading ? (
        <p className="text-sm text-muted-foreground text-center py-4">로딩 중...</p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted-foreground">
              {summary?.unlockedCount || 0} / {summary?.totalCount || achievementKeys.length} 달성
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {achievementKeys.map((key) => (
              <AchievementBadge key={key} achievementKey={key} earned={earnedKeys.has(key)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// =============================================================================
// Economy Section
// =============================================================================

function EconomySection({ companyId }: { companyId: string }) {
  const { data: balance, isLoading: balanceLoading } = useQuery<Rt2TokenBalance>({
    queryKey: ["rt2-economy-balance", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/rt2/economy/balance`);
      if (!res.ok) throw new Error("Failed to fetch balance");
      return res.json();
    },
    enabled: Boolean(companyId),
  });

  const { data: costs, isLoading: costsLoading } = useQuery<Rt2CostBreakdown>({
    queryKey: ["rt2-economy-costs", companyId],
    queryFn: async () => {
      const res = await fetch(`/api/companies/${companyId}/rt2/economy/costs`);
      if (!res.ok) throw new Error("Failed to fetch costs");
      return res.json();
    },
    enabled: Boolean(companyId),
  });

  const isLoading = balanceLoading || costsLoading;

  return (
    <div className="space-y-4">
      {isLoading ? (
        <p className="text-sm text-muted-foreground text-center py-4">로딩 중...</p>
      ) : (
        <>
          {/* Balance Stats */}
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="잔액"
              value={formatNumber(balance?.balanceCents || 0)}
              highlight="green"
            />
            <StatCard
              label="이번달 지출"
              value={formatNumber(balance?.spentThisMonthCents || 0)}
              highlight="amber"
            />
          </div>

          {/* Monthly Budget */}
          <div>
            <div className="text-xs text-muted-foreground mb-1">월 예산</div>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary"
                  style={{
                    width: `${
                      balance
                        ? Math.min(
                            100,
                            (balance.spentThisMonthCents / balance.monthlyBudgetCents) * 100
                          )
                        : 0
                    }%`,
                  }}
                />
              </div>
              <span className="text-xs text-muted-foreground">
                {balance
                  ? Math.round((balance.spentThisMonthCents / balance.monthlyBudgetCents) * 100)
                  : 0}
                %
              </span>
            </div>
          </div>

          {/* Cost Breakdown */}
          {costs && costs.totalCents > 0 && (
            <div>
              <div className="text-xs text-muted-foreground mb-2">비용 분석</div>
              <div className="space-y-2">
                {Object.entries(costs.byAgent)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 5)
                  .map(([agentId, cents]) => (
                    <div key={agentId} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{agentId.slice(0, 8)}...</span>
                      <span className="font-medium">{formatNumber(cents)}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// =============================================================================
// XP Rewards Reference
// =============================================================================

function XpRewardsReference() {
  const rewards = Object.entries(RT2_XP_REWARDS) as [Rt2XpActivityType, number][];

  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">XP 획득량</div>
      <div className="grid grid-cols-2 gap-1">
        {rewards.map(([type, xp]) => (
          <div key={type} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{ACTIVITY_TYPE_LABELS[type]}</span>
            <span className="font-medium">+{xp}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// Main Component
// =============================================================================

type Tab = "leaderboard" | "achievements" | "economy";

export function Rt2GamificationPanel({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId?: string;
}) {
  const [activeTab, setActiveTab] = useState<Tab>("leaderboard");

  const { data: agentScore } = useQuery<Rt2AgentScore>({
    queryKey: ["rt2-gamification-agent-score", companyId, agentId],
    queryFn: async () => {
      if (!agentId) throw new Error("No agentId");
      const res = await fetch(
        `/api/companies/${companyId}/rt2/gamification/agents/${agentId}/score`
      );
      if (!res.ok) throw new Error("Failed to fetch agent score");
      return res.json();
    },
    enabled: Boolean(companyId) && Boolean(agentId),
  });

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">🎮 게이미피케이션</h3>
        </div>
        {agentScore && (
          <div className="flex items-center gap-3 text-xs">
            <span className="text-muted-foreground">
              Lv.{Math.floor(agentScore.overallScore / 100) + 1}
            </span>
            <span className="font-medium">{agentScore.overallScore.toFixed(0)} XP</span>
          </div>
        )}
      </div>

      {/* Quick Stats */}
      {agentScore && (
        <div className="grid grid-cols-3 gap-2">
          <StatCard label="태스크" value={agentScore.tasksCompleted} />
          <StatCard label="품질" value={agentScore.qualityScore.toFixed(1)} />
          <StatCard label="협업" value={agentScore.collaborationScore.toFixed(1)} />
        </div>
      )}

      <CareerMateProgressionSection companyId={companyId} agentId={agentId} />

      {/* Tabs */}
      <div className="flex border-b">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "leaderboard"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("leaderboard")}
        >
          🏆 리더보드
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "achievements"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("achievements")}
        >
          🏅 업적
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === "economy"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setActiveTab("economy")}
        >
          💰 이코노미
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === "leaderboard" && <LeaderboardSection companyId={companyId} />}

      {activeTab === "achievements" && agentId && (
        <AchievementsSection companyId={companyId} agentId={agentId} />
      )}

      {activeTab === "economy" && <EconomySection companyId={companyId} />}

      {/* XP Reference (always visible at bottom) */}
      <details className="group">
        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
          XP 레퍼런스 보기
        </summary>
        <div className="mt-2 pt-2 border-t">
          <XpRewardsReference />
        </div>
      </details>
    </div>
  );
}
