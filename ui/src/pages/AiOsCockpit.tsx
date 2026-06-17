import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Brain, CheckCircle2, CircleDashed, GitPullRequestArrow, PlayCircle, ShieldCheck } from "lucide-react";
import { isRecoveryIssueLike, type Issue } from "@paperclipai/shared";
import { approvalsApi } from "../api/approvals";
import { healthApi } from "../api/health";
import { heartbeatsApi } from "../api/heartbeats";
import { instanceSettingsApi } from "../api/instanceSettings";
import { issuesApi } from "../api/issues";
import { memoryApi } from "../api/memory";
import { EmptyState } from "../components/EmptyState";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { Link } from "@/lib/router";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";

function isRecoveryNoise(issue: Pick<Issue, "originKind" | "title">) {
  return isRecoveryIssueLike(issue);
}

function statusTone(value: "good" | "warn" | "bad" | "neutral") {
  if (value === "good") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  if (value === "warn") return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  if (value === "bad") return "border-red-500/30 bg-red-500/10 text-red-200";
  return "border-border bg-muted/40 text-muted-foreground";
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm text-foreground">{value ?? "none"}</div>
    </div>
  );
}

function StatusPill({ children, tone }: { children: ReactNode; tone: "good" | "warn" | "bad" | "neutral" }) {
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-1 text-xs font-medium", statusTone(tone))}>
      {children}
    </span>
  );
}

export function AiOsCockpit() {
  const { selectedCompanyId, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "AI OS" }]);
  }, [setBreadcrumbs]);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    refetchInterval: 5000,
  });
  const settingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const liveRunsQuery = useQuery({
    queryKey: ["ai-os", selectedCompanyId, "live-runs"],
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!, { limit: 20 }),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 5000,
  });
  const blockedIssuesQuery = useQuery({
    queryKey: ["ai-os", selectedCompanyId, "blocked-issues"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { status: "blocked", limit: 100, sortField: "updated", sortDir: "desc" }),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 5000,
  });
  const approvalsQuery = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: Boolean(selectedCompanyId),
  });
  const recentRunsQuery = useQuery({
    queryKey: ["ai-os", selectedCompanyId, "recent-runs"],
    queryFn: () => heartbeatsApi.list(selectedCompanyId!, undefined, 25),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 10000,
  });
  const memoryQuery = useQuery({
    queryKey: queryKeys.memory.overview(selectedCompanyId!),
    queryFn: () => memoryApi.overview(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 10000,
  });

  const sourceBlockedIssues = useMemo(
    () => (blockedIssuesQuery.data ?? []).filter((issue) => !isRecoveryNoise(issue)),
    [blockedIssuesQuery.data],
  );
  const recoveryBlockedIssues = useMemo(
    () => (blockedIssuesQuery.data ?? []).filter(isRecoveryNoise),
    [blockedIssuesQuery.data],
  );
  const activeRuns = liveRunsQuery.data ?? [];
  const lastRun = recentRunsQuery.data?.[0] ?? null;
  const devServer = healthQuery.data?.devServer;
  const runtimeHealthy = healthQuery.data?.status === "ok";
  const restartClean = devServer
    ? !devServer.restartRequired && devServer.pendingMigrations.length === 0
    : runtimeHealthy;
  const routerState = settingsQuery.data?.enableIssueGraphLivenessAutoRecovery
    ? "auto recovery on"
    : "manual recovery only";
  const memoryOverview = memoryQuery.data ?? null;
  const memoryEnabled = Boolean(memoryOverview?.binding?.enabled);
  const memoryState: "on" | "off" | "unavailable" = memoryQuery.isError
    ? "unavailable"
    : !memoryEnabled
    ? "off"
    : memoryOverview?.providerAvailable
      ? "on"
      : "unavailable";
  const memoryTone = memoryState === "on" ? "good" : memoryState === "unavailable" ? "warn" : "neutral";
  const queryFailures = [
    healthQuery.isError ? `Runtime failed: ${errorMessage(healthQuery.error, "Unable to load runtime health.")}` : null,
    settingsQuery.isError ? `Settings failed: ${errorMessage(settingsQuery.error, "Unable to load recovery settings.")}` : null,
    liveRunsQuery.isError ? `Live runs failed: ${errorMessage(liveRunsQuery.error, "Unable to load live runs.")}` : null,
    blockedIssuesQuery.isError ? `Blocked issues failed: ${errorMessage(blockedIssuesQuery.error, "Unable to load blocked issues.")}` : null,
    approvalsQuery.isError ? `Approvals failed: ${errorMessage(approvalsQuery.error, "Unable to load approvals.")}` : null,
    recentRunsQuery.isError ? `Recent runs failed: ${errorMessage(recentRunsQuery.error, "Unable to load recent runs.")}` : null,
    memoryQuery.isError ? `Memory failed: ${errorMessage(memoryQuery.error, "Unable to load memory overview.")}` : null,
  ].filter((message): message is string => message !== null);
  const nextAction = sourceBlockedIssues[0]
    ? `${sourceBlockedIssues[0].identifier ?? "issue"}: ${sourceBlockedIssues[0].title}`
    : activeRuns[0]
      ? `${activeRuns[0].agentName}: running ${activeRuns[0].issueId ?? "unlinked work"}`
      : "No run-next action queued";

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={ShieldCheck}
        message={companies.length === 0 ? "Create a company to view AI OS." : "Select a company to view AI OS."}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">AI OS</h1>
          <p className="mt-1 text-sm text-muted-foreground">Operator cockpit for goals, blockers, approvals, routing, and run state.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusPill tone={restartClean ? "good" : "bad"}>
            {restartClean ? "runtime clean" : "restart needed"}
          </StatusPill>
          <StatusPill tone={activeRuns.length === 0 ? "good" : "warn"}>
            {activeRuns.length} live run{activeRuns.length === 1 ? "" : "s"}
          </StatusPill>
          <StatusPill tone={recoveryBlockedIssues.length === 0 ? "good" : "warn"}>
            {recoveryBlockedIssues.length} recovery block{recoveryBlockedIssues.length === 1 ? "" : "s"}
          </StatusPill>
        </div>
      </div>

      {queryFailures.length > 0 ? (
        <section className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-200">
          <div className="font-medium">AI OS data failed to load</div>
          <div className="mt-1 space-y-1">
            {queryFailures.map((message) => (
              <div key={message}>{message}</div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><CheckCircle2 className="h-4 w-4" /> Runtime</div>
          <div className="mt-4 grid gap-3">
            <Field label="Restart" value={devServer?.restartRequired ? devServer.reason : "clean"} />
            <Field label="Pending migrations" value={devServer?.pendingMigrations.length ?? 0} />
            <Field label="Active runs" value={devServer?.activeRunCount ?? activeRuns.length} />
          </div>
        </section>
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><GitPullRequestArrow className="h-4 w-4" /> Model route</div>
          <div className="mt-4 grid gap-3">
            <Field label="Recovery mode" value={routerState} />
            <Field label="Run-next" value="allowlisted only" />
            <Field label="Retry automation" value="off" />
          </div>
        </section>
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><AlertTriangle className="h-4 w-4" /> Blocked</div>
          <div className="mt-4 grid gap-3">
            <Field label="Source blocks" value={sourceBlockedIssues.length} />
            <Field label="Recovery blocks" value={recoveryBlockedIssues.length} />
            <Field label="Top reason" value={sourceBlockedIssues[0]?.title ?? "none"} />
          </div>
        </section>
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center gap-2 text-sm font-medium"><PlayCircle className="h-4 w-4" /> Next action</div>
          <div className="mt-4 grid gap-3">
            <Field label="Action" value={nextAction} />
            <Field label="Last run" value={lastRun ? `${lastRun.status} (${lastRun.id.slice(0, 8)})` : "none"} />
            <Field label="Approvals" value={approvalsQuery.data?.length ?? 0} />
          </div>
        </section>
        <section className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium"><Brain className="h-4 w-4" /> Memory</div>
            <StatusPill tone={memoryTone}>{memoryState}</StatusPill>
          </div>
          <div className="mt-4 grid gap-3">
            <Field
              label="Last hydrate"
              value={memoryOverview?.stats.lastHydrateAt ? relativeTime(memoryOverview.stats.lastHydrateAt) : "never"}
            />
            <Field
              label="Last capture"
              value={memoryOverview?.stats.lastCaptureAt ? relativeTime(memoryOverview.stats.lastCaptureAt) : "never"}
            />
            <Field
              label="Ops 24h"
              value={memoryOverview ? `${memoryOverview.stats.opsLast24h} (${memoryOverview.stats.failuresLast24h} failed)` : "none"}
            />
          </div>
          <Link to="/memory" className="mt-3 inline-block text-xs text-muted-foreground hover:text-foreground">
            Open memory →
          </Link>
        </section>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.25fr_0.75fr]">
        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">Blocked source work</div>
          <div className="divide-y divide-border">
            {sourceBlockedIssues.length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">No source issues are blocked.</div>
            ) : sourceBlockedIssues.map((issue) => (
              <Link key={issue.id} to={`/issues/${issue.identifier ?? issue.id}`} className="block px-4 py-3 hover:bg-muted/40">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{issue.identifier ?? issue.id}</div>
                    <div className="mt-1 truncate text-sm text-muted-foreground">{issue.title}</div>
                  </div>
                  <StatusPill tone="warn">{issue.status}</StatusPill>
                </div>
              </Link>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3 text-sm font-medium">Approval choices</div>
          <div className="divide-y divide-border">
            {(approvalsQuery.data ?? []).length === 0 ? (
              <div className="px-4 py-6 text-sm text-muted-foreground">No pending approvals.</div>
            ) : (approvalsQuery.data ?? []).slice(0, 8).map((approval) => (
              <Link key={approval.id} to={`/approvals/${approval.id}`} className="block px-4 py-3 hover:bg-muted/40">
                <div className="truncate text-sm font-medium">{approval.type}</div>
                <div className="mt-1 text-xs text-muted-foreground">{approval.status}</div>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-medium">Live and recent runs</div>
        <div className="divide-y divide-border">
          {activeRuns.length === 0 && !lastRun ? (
            <div className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
              <CircleDashed className="h-4 w-4" /> No live or recent runs.
            </div>
          ) : (
            <>
              {activeRuns.map((run) => (
                <div key={run.id} className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{run.agentName}</div>
                    <div className="truncate text-muted-foreground">{run.issueId ?? "unlinked run"}</div>
                  </div>
                  <StatusPill tone={run.status === "running" ? "warn" : "neutral"}>{run.status}</StatusPill>
                </div>
              ))}
              {lastRun ? (
                <div className="grid gap-2 px-4 py-3 text-sm md:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <div className="truncate font-medium">Last run result</div>
                    <div className="truncate text-muted-foreground">{lastRun.id}</div>
                  </div>
                  <StatusPill tone={lastRun.status === "succeeded" ? "good" : lastRun.status === "failed" ? "bad" : "neutral"}>
                    {lastRun.status}
                  </StatusPill>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
