import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { deploymentsApi, type Deployment } from "../api/deployments";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { DeploymentStatusBadge, EnvironmentBadge } from "../components/DeploymentStatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Rocket, Plus, ExternalLink, Clock } from "lucide-react";

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt || !finishedAt) return "";
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

export function Deployments() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Deployments" }]);
  }, [setBreadcrumbs]);

  const { data: deployments, isLoading, error } = useQuery({
    queryKey: queryKeys.deployments.list(selectedCompanyId!),
    queryFn: () => deploymentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) => deploymentsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.deployments.list(selectedCompanyId!) });
      setShowCreateForm(false);
    },
  });

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    createMutation.mutate({
      environment: formData.get("environment") as string || "staging",
      provider: formData.get("provider") as string || undefined,
      url: formData.get("url") as string || undefined,
    });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Rocket} message="Select a company to view deployments." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {deployments && deployments.length === 0 && !showCreateForm && (
        <div className="flex flex-col items-center gap-4 py-12">
          <Rocket className="h-12 w-12 text-muted-foreground/40" />
          <h2 className="text-lg font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">Deployments</h2>
          <p className="text-sm text-muted-foreground max-w-lg text-center">
            Deployments track every release your agents push to staging, production, or preview environments.
            Monitor status, rollback history, and deployment URLs all in one place.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-xl text-xs text-muted-foreground">
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">Environment Tracking</p>
              <p>Track staging, production, development, and preview deploys separately</p>
            </div>
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">Provider Integration</p>
              <p>Connect Vercel, Netlify, AWS, or any custom deployment provider</p>
            </div>
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">Status & History</p>
              <p>Real-time deployment status, duration tracking, and rollback support</p>
            </div>
          </div>
          <Button size="sm" onClick={() => setShowCreateForm(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Deployment
          </Button>
        </div>
      )}

      {(deployments && deployments.length > 0 || showCreateForm) && (
        <>
          <div className="flex items-center justify-end">
            <Button size="sm" variant="outline" onClick={() => setShowCreateForm((v) => !v)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Deployment
            </Button>
          </div>

          {showCreateForm && (
            <form onSubmit={handleCreate} className="rounded-[2px] border border-border bg-card p-4 space-y-3 hud-panel hud-shimmer">
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Environment</label>
                  <select
                    name="environment"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  >
                    <option value="staging">Staging</option>
                    <option value="production">Production</option>
                    <option value="development">Development</option>
                    <option value="preview">Preview</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Provider</label>
                  <input
                    name="provider"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder="e.g. vercel, netlify"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">URL</label>
                  <input
                    name="url"
                    type="url"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder="https://..."
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Deploying..." : "Create Deployment"}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => setShowCreateForm(false)}>
                  Cancel
                </Button>
              </div>
              {createMutation.error && (
                <p className="text-xs text-destructive">{createMutation.error.message}</p>
              )}
            </form>
          )}

          <div className="rounded-[2px] border border-border overflow-hidden overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Environment</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Provider</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Duration</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Started</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">URL</th>
                </tr>
              </thead>
              <tbody>
                {deployments?.map((d) => (
                  <tr key={d.id} className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors">
                    <td className="px-4 py-3">
                      <EnvironmentBadge environment={d.environment} />
                    </td>
                    <td className="px-4 py-3">
                      <DeploymentStatusBadge status={d.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {d.provider ?? "-"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {d.finishedAt ? (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatDuration(d.startedAt, d.finishedAt)}
                        </span>
                      ) : d.status === "running" ? (
                        <span className="text-cyan-600 dark:text-cyan-400 animate-pulse">running</span>
                      ) : (
                        "-"
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatRelativeTime(d.startedAt || d.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {d.url ? (
                        <a
                          href={d.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Visit
                        </a>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
