import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Cog } from "lucide-react";
import { opsApi, type JobStatus } from "../api/agnbOps";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { AgnbSubnav } from "../components/AgnbSubnav";
import { Badge } from "@/components/ui/badge";
import { relativeTime } from "../lib/utils";

type Tone = "default" | "secondary" | "destructive" | "outline";

function cadence(ms: number): string {
  const m = ms / 60000;
  if (m < 60) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

function health(j: JobStatus): { label: string; tone: Tone } {
  if (j.missingEnv.length > 0) return { label: `needs ${j.missingEnv.join(", ")}`, tone: "outline" };
  if (!j.enabled) return { label: "off", tone: "secondary" };
  if (j.running) return { label: "running", tone: "default" };
  if (j.lastResult && (j.lastResult as { ok: boolean }).ok === false) return { label: "failed", tone: "destructive" };
  if (!j.lastRunAt) return { label: "pending first run", tone: "outline" };
  return { label: "ok", tone: "default" };
}

function resultText(j: JobStatus): string {
  const r = j.lastResult;
  if (!r) return "";
  if ((r as { ok: boolean }).ok === false) return (r as { error?: string }).error ?? "failed";
  return (r as { summary?: string }).summary ?? "ok";
}

/**
 * Job-health view for the AGNB scheduler (server/src/agnb/scheduler.ts): each
 * data-sync / automation job's cadence, last run + result, missing env keys, and
 * a health badge — so a silently-erroring or unconfigured sync is visible.
 */
export function Jobs() {
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => setBreadcrumbs([{ label: "Jobs" }]), [setBreadcrumbs]);
  const { data, isLoading, error } = useQuery({
    queryKey: ["agnb", "jobs"],
    queryFn: () => opsApi.jobs(),
    refetchInterval: 30_000,
  });

  const jobs = (data?.jobs ?? []).slice().sort((a, b) => a.key.localeCompare(b.key));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Jobs</h1>
        <span className="text-xs text-muted-foreground">
          scheduler {data?.enabled ? "on" : "off"} · {jobs.length} jobs
        </span>
      </div>
      <AgnbSubnav group="ops" />
      {error && <p className="text-sm text-destructive">{(error as Error).message}</p>}
      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : jobs.length === 0 ? (
        <EmptyState icon={Cog} message="No scheduler jobs." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-2">Job</th>
                <th className="p-2">Every</th>
                <th className="p-2">Last run</th>
                <th className="p-2">Result</th>
                <th className="p-2">Health</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const h = health(j);
                return (
                  <tr key={j.key} className="border-b border-border/60">
                    <td className="p-2 font-mono text-xs">{j.key}</td>
                    <td className="p-2 text-xs">{cadence(j.intervalMs)}</td>
                    <td className="p-2 text-xs">
                      {j.lastRunAt ? relativeTime(new Date(j.lastRunAt).toISOString()) : <span className="text-muted-foreground">never</span>}
                      {j.lastDurationMs != null && <span className="ml-1 text-[11px] text-muted-foreground">({j.lastDurationMs}ms)</span>}
                    </td>
                    <td className="p-2 max-w-[280px] truncate text-xs text-muted-foreground">{resultText(j)}</td>
                    <td className="p-2"><Badge variant={h.tone}>{h.label}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
