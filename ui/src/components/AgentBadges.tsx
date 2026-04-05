import { useMemo } from "react";
import { Award, Flame, Shield, Zap, Wallet } from "lucide-react";
import { cn } from "../lib/utils";
import type { HeartbeatRun } from "@ironworksai/shared";

/* ── Badge definitions ── */

export interface AgentBadge {
  key: string;
  label: string;
  description: string;
  icon: typeof Award;
  color: string;
  bgColor: string;
}

const BADGE_DEFS: AgentBadge[] = [
  {
    key: "century",
    label: "Century",
    description: "100+ tasks completed",
    icon: Award,
    color: "text-amber-500",
    bgColor: "bg-amber-500/10",
  },
  {
    key: "streak",
    label: "Streak",
    description: "7+ consecutive days with completions",
    icon: Flame,
    color: "text-orange-500",
    bgColor: "bg-orange-500/10",
  },
  {
    key: "zero_failures",
    label: "Zero Failures",
    description: "0 failed runs in last 30 days",
    icon: Shield,
    color: "text-emerald-500",
    bgColor: "bg-emerald-500/10",
  },
  {
    key: "speed_demon",
    label: "Speed Demon",
    description: "Avg cycle time under 1 hour",
    icon: Zap,
    color: "text-cyan-500",
    bgColor: "bg-cyan-500/10",
  },
  {
    key: "budget_hero",
    label: "Budget Hero",
    description: "Consistently under budget",
    icon: Wallet,
    color: "text-indigo-500",
    bgColor: "bg-indigo-500/10",
  },
];

/* ── Evaluation logic ── */

interface AgentBadgesInput {
  runs: HeartbeatRun[];
  assignedIssues: {
    id: string;
    status: string;
    completedAt?: Date | null;
    startedAt?: Date | null;
    createdAt: Date;
  }[];
  totalCostCents?: number;
  budgetCents?: number;
}

export function computeEarnedBadges(input: AgentBadgesInput): AgentBadge[] {
  const { runs, assignedIssues, totalCostCents, budgetCents } = input;
  const earned: AgentBadge[] = [];
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  // Century: 100+ completed tasks
  const completedCount = assignedIssues.filter((i) => i.status === "done").length;
  if (completedCount >= 100) {
    earned.push(BADGE_DEFS.find((b) => b.key === "century")!);
  }

  // Streak: 7+ consecutive days with at least one completion
  const completedDates = assignedIssues
    .filter((i) => i.status === "done" && i.completedAt)
    .map((i) => {
      const d = new Date(i.completedAt!);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    });
  const uniqueDays = [...new Set(completedDates)].sort((a, b) => b - a);
  let maxStreak = 0;
  let streak = 1;
  for (let i = 1; i < uniqueDays.length; i++) {
    const diff = uniqueDays[i - 1] - uniqueDays[i];
    if (diff === 86400000) {
      streak++;
      maxStreak = Math.max(maxStreak, streak);
    } else {
      streak = 1;
    }
  }
  maxStreak = Math.max(maxStreak, streak);
  if (uniqueDays.length > 0 && maxStreak >= 7) {
    earned.push(BADGE_DEFS.find((b) => b.key === "streak")!);
  }

  // Zero Failures: 0 failed runs in last 30 days
  const recentRuns = runs.filter(
    (r) => new Date(r.createdAt).getTime() > thirtyDaysAgo,
  );
  const failedRecent = recentRuns.filter((r) => r.status === "failed").length;
  if (recentRuns.length >= 5 && failedRecent === 0) {
    earned.push(BADGE_DEFS.find((b) => b.key === "zero_failures")!);
  }

  // Speed Demon: avg cycle time < 1 hour for completed issues in last 30 days
  const recentCompleted = assignedIssues.filter(
    (i) =>
      i.status === "done" &&
      i.completedAt &&
      i.startedAt &&
      new Date(i.completedAt).getTime() > thirtyDaysAgo,
  );
  if (recentCompleted.length >= 3) {
    const avgCycleMs =
      recentCompleted.reduce(
        (sum, i) =>
          sum + (new Date(i.completedAt!).getTime() - new Date(i.startedAt!).getTime()),
        0,
      ) / recentCompleted.length;
    if (avgCycleMs < 60 * 60 * 1000) {
      earned.push(BADGE_DEFS.find((b) => b.key === "speed_demon")!);
    }
  }

  // Budget Hero: total cost < 80% of budget (when budget is set)
  if (
    typeof budgetCents === "number" &&
    budgetCents > 0 &&
    typeof totalCostCents === "number"
  ) {
    if (totalCostCents <= budgetCents * 0.8) {
      earned.push(BADGE_DEFS.find((b) => b.key === "budget_hero")!);
    }
  }

  return earned;
}

/* ── Full badges panel (for agent detail) ── */

interface AgentBadgesProps {
  badges: AgentBadge[];
  className?: string;
}

export function AgentBadgesPanel({ badges, className }: AgentBadgesProps) {
  if (badges.length === 0) return null;

  return (
    <div className={cn("rounded-xl border border-border p-4 space-y-3", className)}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Achievements
      </h3>
      <div className="flex flex-wrap gap-2">
        {badges.map((badge) => {
          const Icon = badge.icon;
          return (
            <div
              key={badge.key}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 border border-border",
                badge.bgColor,
              )}
              title={badge.description}
            >
              <Icon className={cn("h-4 w-4 shrink-0", badge.color)} />
              <div className="min-w-0">
                <p className="text-xs font-medium">{badge.label}</p>
                <p className="text-[10px] text-muted-foreground">{badge.description}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Compact badges row (for agent list) ── */

interface AgentBadgeIconsProps {
  badges: AgentBadge[];
  className?: string;
}

export function AgentBadgeIcons({ badges, className }: AgentBadgeIconsProps) {
  if (badges.length === 0) return null;

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {badges.map((badge) => {
        const Icon = badge.icon;
        return (
          <span
            key={badge.key}
            title={`${badge.label}: ${badge.description}`}
            className={cn("inline-flex", badge.color)}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
        );
      })}
    </div>
  );
}

/* ── Hook for convenient usage ── */

export function useAgentBadges(input: AgentBadgesInput): AgentBadge[] {
  return useMemo(() => computeEarnedBadges(input), [
    input.runs,
    input.assignedIssues,
    input.totalCostCents,
    input.budgetCents,
  ]);
}
