import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { evaluationsApi, type RoleSummary, type PosteriorResult } from "../api/evaluations";
import { queryKeys } from "../lib/queryKeys";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { PageSkeleton } from "../components/PageSkeleton";
import { StatusBadge } from "../components/StatusBadge";
import { cn } from "../lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, Trophy, TrendingUp, AlertTriangle } from "lucide-react";

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
  promoting: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  paused: "bg-muted text-muted-foreground",
};

function getStatusColor(status: string | null): string {
  return STATUS_COLORS[status ?? ""] ?? "bg-muted text-muted-foreground";
}

function formatPercent(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatMs(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${value.toLocaleString()}ms`;
}

function formatQuality(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toFixed(2);
}

function PBadge({ pBA }: { pBA: number }) {
  const confidence = pBA > 0.8 || pBA < 0.2;
  const label = pBA > 0.5 ? `P(B>A) = ${(pBA * 100).toFixed(1)}%` : `P(A>B) = ${((1 - pBA) * 100).toFixed(1)}%`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        confidence
          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
          : "bg-muted text-muted-foreground"
      )}
    >
      {label}
    </span>
  );
}

function RecommendationBadge({ recommendation }: { recommendation: string | null }) {
  if (!recommendation) {
    return <span className="text-xs text-muted-foreground">Insufficient data</span>;
  }
  if (recommendation === "swap_to_challenger") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300">
        <TrendingUp className="h-3 w-3" />
        Promote challenger
      </span>
    );
  }
  if (recommendation === "keep_primary") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/50 dark:text-green-300">
        <Trophy className="h-3 w-3" />
        Keep primary
      </span>
    );
  }
  return null;
}

interface ModelRowProps {
  label: string;
  stats: RoleSummary["primaryStats"] | RoleSummary["challengerStats"];
  isPrimary: boolean;
}

function ModelRow({ label, stats, isPrimary }: ModelRowProps) {
  if (!stats) {
    return (
      <tr className="border-b border-border">
        <td className="px-3 py-2.5 text-sm font-medium">{label}</td>
        <td colSpan={5} className="px-3 py-2.5 text-sm text-muted-foreground">
          No data
        </td>
      </tr>
    );
  }
  return (
    <tr className="border-b border-border">
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
              isPrimary
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
                : "bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300"
            )}
          >
            {label}
          </span>
        </div>
      </td>
      <td className="px-3 py-2.5 text-sm tabular-nums">{stats.evaluations.toLocaleString()}</td>
      <td className="px-3 py-2.5 text-sm tabular-nums">{formatPercent(stats.successRate)}</td>
      <td className="px-3 py-2.5 text-sm tabular-nums">{formatQuality(stats.avgQuality)}</td>
      <td className="px-3 py-2.5 text-sm tabular-nums">{formatMs(stats.avgLatencyMs)}</td>
    </tr>
  );
}

interface RoleCardProps {
  roleSummary: RoleSummary;
}

function RoleCard({ roleSummary }: RoleCardProps) {
  const { data: posterior } = useQuery({
    queryKey: queryKeys.evaluations.posterior(roleSummary.role),
    queryFn: () => evaluationsApi.posterior(roleSummary.role),
    enabled: !!roleSummary.primaryModel && !!roleSummary.challengerModel,
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-semibold">{roleSummary.role}</CardTitle>
          <div className="flex items-center gap-2">
            {roleSummary.pairingStatus && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                  getStatusColor(roleSummary.pairingStatus)
                )}
              >
                {roleSummary.pairingStatus}
              </span>
            )}
            <RecommendationBadge recommendation={roleSummary.recommendation} />
          </div>
        </div>
        {roleSummary.trialsCompletedAt && (
          <p className="mt-1 text-xs text-muted-foreground">
            Last updated: {new Date(roleSummary.trialsCompletedAt).toLocaleDateString()}
          </p>
        )}
      </CardHeader>
      <CardContent className="px-0">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Model</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Evals</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Success Rate</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Avg Quality</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Avg Latency</th>
            </tr>
          </thead>
          <tbody>
            <ModelRow
              label="Primary"
              stats={roleSummary.primaryStats}
              isPrimary={true}
            />
            <ModelRow
              label="Challenger"
              stats={roleSummary.challengerStats}
              isPrimary={false}
            />
          </tbody>
        </table>
        {posterior?.data && (
          <div className="mt-3 flex items-center justify-end px-3">
            <PBadge pBA={posterior.data.pBA} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function Leaderboard() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedRole, setSelectedRole] = useState<string>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.evaluations.summary,
    queryFn: () => evaluationsApi.summary(),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Operations" }, { label: "Leaderboard" }]);
  }, [setBreadcrumbs]);

  const roles = useMemo(() => {
    return (data?.data ?? []).map((r) => r.role).sort();
  }, [data]);

  const filteredData = useMemo(() => {
    if (selectedRole === "all") return data?.data ?? [];
    return (data?.data ?? []).filter((r) => r.role === selectedRole);
  }, [data, selectedRole]);

  if (isLoading) {
    return (
      <div className="p-6">
        <PageSkeleton variant="costs" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load leaderboard data
        </div>
      </div>
    );
  }

  if (!data?.data?.length) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <Trophy className="mx-auto h-8 w-8 text-muted-foreground" />
          <h3 className="mt-3 text-sm font-medium">No evaluation data yet</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Model evaluations will appear here once canary pairings have been running.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold">Model Leaderboard</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Per-role model performance comparison
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedRole} onValueChange={setSelectedRole}>
            <SelectTrigger className="w-48">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {roles.map((role) => (
                <SelectItem key={role} value={role}>
                  {role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-4">
        {filteredData.map((roleSummary) => (
          <RoleCard key={roleSummary.role} roleSummary={roleSummary} />
        ))}
      </div>
    </div>
  );
}