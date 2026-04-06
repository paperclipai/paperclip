import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { sandboxesApi, type SandboxEnvironment, type CreateSandboxInput } from "../api/sandboxes";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusBadge } from "../components/StatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Container,
  Plus,
  Play,
  Square,
  Trash2,
  ExternalLink,
  Terminal,
  AlertCircle,
  Clock,
  Cpu,
  HardDrive,
  MemoryStick,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

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

const sandboxStatusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300",
  running: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300",
  stopped: "bg-muted text-muted-foreground",
  error: "bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300",
  provisioning: "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
};

function SandboxStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-[2px] px-2.5 py-0.5 text-[9px] font-medium font-[var(--font-mono)] uppercase whitespace-nowrap shrink-0 ${
        sandboxStatusColors[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {status}
    </span>
  );
}

function ProviderBadge({ provider }: { provider: string }) {
  const colors: Record<string, string> = {
    e2b: "bg-violet-50 text-violet-600 border-violet-200 dark:bg-violet-950/30 dark:text-violet-400 dark:border-violet-800",
    docker: "bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-950/30 dark:text-blue-400 dark:border-blue-800",
  };
  return (
    <span
      className={`inline-flex items-center rounded-[2px] border px-2 py-0.5 text-[9px] font-medium font-[var(--font-mono)] uppercase whitespace-nowrap shrink-0 ${
        colors[provider] ?? "bg-muted/50 text-muted-foreground border-border"
      }`}
    >
      {provider.toUpperCase()}
    </span>
  );
}

export function Sandboxes() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Sandboxes" }]);
  }, [setBreadcrumbs]);

  const { data: sandboxes, isLoading, error } = useQuery({
    queryKey: queryKeys.sandboxes.list(selectedCompanyId!),
    queryFn: () => sandboxesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const createMutation = useMutation({
    mutationFn: (data: CreateSandboxInput) => sandboxesApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.list(selectedCompanyId!) });
      setShowCreateForm(false);
      pushToast({ title: "Sandbox created", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to create sandbox", body: err.message, tone: "error" });
    },
  });

  const startMutation = useMutation({
    mutationFn: (id: string) => sandboxesApi.start(selectedCompanyId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.list(selectedCompanyId!) });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) => sandboxesApi.stop(selectedCompanyId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.list(selectedCompanyId!) });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => sandboxesApi.remove(selectedCompanyId!, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.sandboxes.list(selectedCompanyId!) });
      pushToast({ title: "Sandbox deleted", tone: "info" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to delete sandbox", body: err.message, tone: "error" });
    },
  });

  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const input: CreateSandboxInput = {
      provider: formData.get("provider") as string || "e2b",
      region: formData.get("region") as string || "us-east-1",
      template: formData.get("template") as string || undefined,
      timeoutSeconds: parseInt(formData.get("timeoutSeconds") as string) || 300,
      cpuMillicores: parseInt(formData.get("cpuMillicores") as string) || 1000,
      memoryMb: parseInt(formData.get("memoryMb") as string) || 512,
      diskMb: parseInt(formData.get("diskMb") as string) || 1024,
    };
    createMutation.mutate(input);
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Container} message="Select a company to view sandboxes." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {sandboxes && sandboxes.length === 0 && !showCreateForm && (
        <div className="flex flex-col items-center gap-4 py-12">
          <Container className="h-12 w-12 text-muted-foreground/40" />
          <h2 className="text-lg font-semibold font-[var(--font-display)] uppercase tracking-[0.06em]">Sandboxes</h2>
          <p className="text-sm text-muted-foreground max-w-lg text-center">
            Sandboxes are isolated cloud environments where your AI agents can safely execute code,
            run scripts, and interact with tools without affecting your production systems.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-xl text-xs text-muted-foreground">
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">Safe Execution</p>
              <p>Agents run code in isolated containers with no access to your live infrastructure</p>
            </div>
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">Resource Control</p>
              <p>Configure CPU, memory, disk, and timeout limits per sandbox environment</p>
            </div>
            <div className="rounded-md border border-border p-3 space-y-1">
              <p className="font-medium text-foreground">Provider Support</p>
              <p>Use E2B, Docker, or other providers for flexible cloud-based execution</p>
            </div>
          </div>
          <Button size="sm" onClick={() => setShowCreateForm(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Sandbox
          </Button>
        </div>
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete sandbox</AlertDialogTitle>
            <AlertDialogDescription>
              Delete this sandbox environment? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) removeMutation.mutate(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {(sandboxes && sandboxes.length > 0 || showCreateForm) && (
        <>
          <div className="flex items-center justify-end">
            <Button size="sm" variant="outline" onClick={() => setShowCreateForm((v) => !v)}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Sandbox
            </Button>
          </div>

          {showCreateForm && (
            <form onSubmit={handleCreate} className="rounded-[2px] border border-border bg-card p-4 space-y-3 hud-panel hud-shimmer">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Provider</label>
                  <select
                    name="provider"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  >
                    <option value="e2b">E2B</option>
                    <option value="docker">Docker</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Region</label>
                  <select
                    name="region"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  >
                    <option value="us-east-1">US East 1</option>
                    <option value="us-west-2">US West 2</option>
                    <option value="eu-west-1">EU West 1</option>
                    <option value="ap-southeast-1">AP Southeast 1</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Template</label>
                  <input
                    name="template"
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                    placeholder="e.g. base, ubuntu:22.04"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Timeout (seconds)</label>
                  <input
                    name="timeoutSeconds"
                    type="number"
                    defaultValue={300}
                    min={30}
                    max={3600}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">CPU (millicores)</label>
                  <input
                    name="cpuMillicores"
                    type="number"
                    defaultValue={1000}
                    min={100}
                    max={8000}
                    step={100}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Memory (MB)</label>
                  <input
                    name="memoryMb"
                    type="number"
                    defaultValue={512}
                    min={128}
                    max={16384}
                    step={128}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Disk (MB)</label>
                  <input
                    name="diskMb"
                    type="number"
                    defaultValue={1024}
                    min={256}
                    max={65536}
                    step={256}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Creating..." : "Create Sandbox"}
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
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Provider</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Template</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Resources</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Region</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Created</th>
                  <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sandboxes?.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0 hover:bg-accent/30 transition-colors">
                    <td className="px-4 py-3">
                      <ProviderBadge provider={s.provider} />
                    </td>
                    <td className="px-4 py-3">
                      <SandboxStatusBadge status={s.status} />
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {s.template ?? "default"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1" title="CPU">
                          <Cpu className="h-3 w-3" />
                          {s.cpuMillicores}m
                        </span>
                        <span className="flex items-center gap-1" title="Memory">
                          <MemoryStick className="h-3 w-3" />
                          {s.memoryMb}MB
                        </span>
                        <span className="flex items-center gap-1" title="Disk">
                          <HardDrive className="h-3 w-3" />
                          {s.diskMb}MB
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      {s.region ?? "-"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground text-xs">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatRelativeTime(s.createdAt)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {s.status === "running" && s.sandboxUrl && (
                          <a
                            href={s.sandboxUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-accent"
                            title="Open sandbox"
                          >
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                        {s.status === "running" && s.terminalUrl && (
                          <a
                            href={s.terminalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-green-600 dark:text-green-400 hover:bg-accent"
                            title="Open terminal"
                          >
                            <Terminal className="h-3 w-3" />
                          </a>
                        )}
                        {(s.status === "pending" || s.status === "stopped" || s.status === "error") && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => startMutation.mutate(s.id)}
                            disabled={startMutation.isPending}
                            title="Start sandbox"
                          >
                            <Play className="h-3.5 w-3.5 text-green-600" />
                          </Button>
                        )}
                        {s.status === "running" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0"
                            onClick={() => stopMutation.mutate(s.id)}
                            disabled={stopMutation.isPending}
                            title="Stop sandbox"
                          >
                            <Square className="h-3.5 w-3.5 text-orange-600" />
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0"
                          onClick={() => setDeleteTarget(s.id)}
                          disabled={removeMutation.isPending}
                          title="Delete sandbox"
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-600" />
                        </Button>
                      </div>
                      {s.errorMessage && (
                        <div className="mt-1 flex items-start gap-1 text-xs text-destructive max-w-xs">
                          <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                          <span className="break-words">{s.errorMessage}</span>
                        </div>
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
