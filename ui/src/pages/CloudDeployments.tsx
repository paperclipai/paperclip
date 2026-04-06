import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { deploymentsApi, type Deployment } from "../api/deployments";
import {
  cloudDeploymentsApi,
  type HealthCheck,
  type DeploymentRecipe,
  type RecipeInput,
  type CloudDeployInput,
} from "../api/cloud-deployments";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Cloud,
  Plus,
  Heart,
  RefreshCw,
  Trash2,
  Pencil,
  Undo2,
  Rocket,
  Activity,
  ChefHat,
  X,
  ExternalLink,
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

type Tab = "health" | "recipes";

function HealthBadge({ status }: { status: string }) {
  const cls = statusBadge[status] ?? statusBadgeDefault;
  return (
    <span className={`inline-flex items-center rounded-[2px] px-2 py-0.5 text-xs font-[var(--font-mono)] ${cls}`}>
      {status}
    </span>
  );
}

function ProviderBadge({ provider }: { provider: string | null }) {
  if (!provider) return <span className="text-muted-foreground">-</span>;
  const colors: Record<string, string> = {
    aws: "bg-[var(--status-warning)]/15 text-[var(--status-warning)]",
    gcp: "bg-[var(--status-info)]/15 text-[var(--status-info)]",
    azure: "bg-[var(--primary)]/15 text-[var(--primary)]",
  };
  const cls = colors[provider] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded-[2px] px-2 py-0.5 text-xs font-[var(--font-mono)] uppercase ${cls}`}>
      {provider}
    </span>
  );
}

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Health check history for a single deployment
function HealthCheckHistory({
  companyId,
  deploymentId,
  onClose,
}: {
  companyId: string;
  deploymentId: string;
  onClose: () => void;
}) {
  const { data: checks, isLoading } = useQuery({
    queryKey: queryKeys.cloudDeployments.healthChecks(companyId, deploymentId),
    queryFn: () => cloudDeploymentsApi.listHealthChecks(companyId, deploymentId),
  });

  return (
    <div className="hud-panel hud-shimmer rounded-[2px] border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="hud-section-header">Health Check History</h3>
        <Button size="icon-sm" variant="ghost" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      {isLoading && <p className="text-xs text-muted-foreground">Loading...</p>}
      {checks && checks.length === 0 && (
        <p className="text-xs text-muted-foreground">No health checks recorded yet.</p>
      )}
      {checks && checks.length > 0 && (
        <div className="max-h-60 overflow-y-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Status</th>
                <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Response</th>
                <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Code</th>
                <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Time</th>
                <th className="text-left py-1.5 px-2 font-medium text-muted-foreground">Message</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id} className="border-b border-border last:border-0">
                  <td className="py-1.5 px-2"><HealthBadge status={c.status} /></td>
                  <td className="py-1.5 px-2">{c.responseTimeMs != null ? `${c.responseTimeMs}ms` : "-"}</td>
                  <td className="py-1.5 px-2">{c.statusCode ?? "-"}</td>
                  <td className="py-1.5 px-2 text-muted-foreground">{formatRelativeTime(c.checkedAt)}</td>
                  <td className="py-1.5 px-2 text-muted-foreground truncate max-w-[200px]">{c.message ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Cloud deploy dialog
function CloudDeployDialog({
  companyId,
  deploymentId,
  onClose,
}: {
  companyId: string;
  deploymentId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const deployMutation = useMutation({
    mutationFn: (data: CloudDeployInput) =>
      cloudDeploymentsApi.deployToCloud(companyId, deploymentId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.deployments.list(companyId) });
      onClose();
      pushToast({ title: "Cloud deployment started", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to deploy", body: err.message, tone: "error" });
    },
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const cloudProvider = fd.get("cloudProvider") as string;
    const cloudRegion = fd.get("cloudRegion") as string;
    const cloudResourceType = fd.get("cloudResourceType") as string;
    const dockerImage = fd.get("dockerImage") as string;
    const version = fd.get("version") as string;
    const domain = fd.get("domain") as string;

    let cloudConfig: Record<string, unknown> = {};
    const configRaw = fd.get("cloudConfig") as string;
    if (configRaw) {
      try {
        cloudConfig = JSON.parse(configRaw);
      } catch {
        // ignore parse error
      }
    }

    deployMutation.mutate({
      cloudProvider,
      cloudRegion: cloudRegion || undefined,
      cloudResourceType: cloudResourceType || undefined,
      cloudConfig,
      dockerImage: dockerImage || undefined,
      version: version || undefined,
      domain: domain || undefined,
    });
  }

  return (
    <div className="hud-panel hud-shimmer rounded-[2px] border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="hud-section-header">Deploy to Cloud</h3>
        <Button size="icon-sm" variant="ghost" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Provider *</label>
            <select
              name="cloudProvider"
              required
              className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
            >
              <option value="">Select...</option>
              <option value="aws">AWS</option>
              <option value="gcp">GCP</option>
              <option value="azure">Azure</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Region</label>
            <input
              name="cloudRegion"
              className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
              placeholder="e.g. us-east-1"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Resource Type</label>
            <input
              name="cloudResourceType"
              className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
              placeholder="e.g. ecs, cloud-run"
            />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Docker Image</label>
            <input
              name="dockerImage"
              className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
              placeholder="registry/image:tag"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Version</label>
            <input
              name="version"
              className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
              placeholder="e.g. v1.2.0"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Domain</label>
            <input
              name="domain"
              className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
              placeholder="app.example.com"
            />
          </div>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Cloud Config (JSON)</label>
          <textarea
            name="cloudConfig"
            rows={3}
            className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm font-[var(--font-mono)]"
            placeholder='{"cluster": "my-cluster", "service": "my-service"}'
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={deployMutation.isPending}>
            <Rocket className="h-3.5 w-3.5 mr-1.5" />
            {deployMutation.isPending ? "Deploying..." : "Deploy"}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </div>
        {deployMutation.error && (
          <p className="text-xs text-destructive">{deployMutation.error.message}</p>
        )}
      </form>
    </div>
  );
}

// Recipe form
function RecipeForm({
  companyId,
  recipe,
  onClose,
}: {
  companyId: string;
  recipe?: DeploymentRecipe;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const isEdit = !!recipe;

  const createMutation = useMutation({
    mutationFn: (data: RecipeInput) => cloudDeploymentsApi.createRecipe(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cloudDeployments.recipes(companyId) });
      onClose();
      pushToast({ title: "Recipe created", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to create recipe", body: err.message, tone: "error" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: Partial<RecipeInput>) =>
      cloudDeploymentsApi.updateRecipe(companyId, recipe!.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cloudDeployments.recipes(companyId) });
      onClose();
      pushToast({ title: "Recipe updated", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to update recipe", body: err.message, tone: "error" });
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;
  const error = createMutation.error || updateMutation.error;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const data: RecipeInput = {
      name: fd.get("name") as string,
      description: (fd.get("description") as string) || null,
      cloudProvider: fd.get("cloudProvider") as string,
      cloudRegion: (fd.get("cloudRegion") as string) || "us-east-1",
      resourceType: fd.get("resourceType") as string,
    };

    const configRaw = fd.get("configTemplate") as string;
    if (configRaw) {
      try {
        data.configTemplate = JSON.parse(configRaw);
      } catch {
        // keep default
      }
    }

    const envRaw = fd.get("envTemplate") as string;
    if (envRaw) {
      try {
        data.envTemplate = JSON.parse(envRaw);
      } catch {
        // keep default
      }
    }

    if (isEdit) {
      updateMutation.mutate(data);
    } else {
      createMutation.mutate(data);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="hud-panel hud-shimmer rounded-[2px] border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="hud-section-header">{isEdit ? "Edit Recipe" : "New Recipe"}</h3>
        <Button size="icon-sm" variant="ghost" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Name *</label>
          <input
            name="name"
            required
            defaultValue={recipe?.name}
            className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <input
            name="description"
            defaultValue={recipe?.description ?? ""}
            className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Provider *</label>
          <select
            name="cloudProvider"
            required
            defaultValue={recipe?.cloudProvider}
            className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
          >
            <option value="">Select...</option>
            <option value="aws">AWS</option>
            <option value="gcp">GCP</option>
            <option value="azure">Azure</option>
          </select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Region</label>
          <input
            name="cloudRegion"
            defaultValue={recipe?.cloudRegion ?? "us-east-1"}
            className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Resource Type *</label>
          <input
            name="resourceType"
            required
            defaultValue={recipe?.resourceType}
            className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm"
            placeholder="e.g. ecs, cloud-run, container-app"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground">Config Template (JSON)</label>
          <textarea
            name="configTemplate"
            rows={3}
            defaultValue={recipe ? JSON.stringify(recipe.configTemplate, null, 2) : ""}
            className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm font-[var(--font-mono)]"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground">Env Template (JSON)</label>
          <textarea
            name="envTemplate"
            rows={3}
            defaultValue={recipe?.envTemplate ? JSON.stringify(recipe.envTemplate, null, 2) : ""}
            className="mt-1 w-full rounded-[2px] border border-input bg-background px-3 py-1.5 text-sm font-[var(--font-mono)]"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isPending}>
          {isPending ? "Saving..." : isEdit ? "Update Recipe" : "Create Recipe"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error.message}</p>}
    </form>
  );
}

export function CloudDeployments() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("health");
  const [selectedDeploymentId, setSelectedDeploymentId] = useState<string | null>(null);
  const [showCloudDeploy, setShowCloudDeploy] = useState<string | null>(null);
  const [showRecipeForm, setShowRecipeForm] = useState(false);
  const [editingRecipe, setEditingRecipe] = useState<DeploymentRecipe | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  const [deleteRecipeTarget, setDeleteRecipeTarget] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Cloud Deploy" }]);
  }, [setBreadcrumbs]);

  const { data: deploymentsList, isLoading: deploymentsLoading } = useQuery({
    queryKey: queryKeys.deployments.list(selectedCompanyId!),
    queryFn: () => deploymentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 15_000,
  });

  const { data: recipes, isLoading: recipesLoading } = useQuery({
    queryKey: queryKeys.cloudDeployments.recipes(selectedCompanyId!),
    queryFn: () => cloudDeploymentsApi.listRecipes(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeTab === "recipes",
  });

  const healthCheckMutation = useMutation({
    mutationFn: ({ deploymentId }: { deploymentId: string }) =>
      cloudDeploymentsApi.runHealthCheck(selectedCompanyId!, deploymentId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.deployments.list(selectedCompanyId!) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.cloudDeployments.healthChecks(selectedCompanyId!, variables.deploymentId),
      });
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: ({ deploymentId }: { deploymentId: string }) =>
      cloudDeploymentsApi.rollback(selectedCompanyId!, deploymentId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.deployments.list(selectedCompanyId!) });
      pushToast({ title: "Deployment rolled back", tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to rollback deployment", body: err.message, tone: "error" });
    },
  });

  const deleteRecipeMutation = useMutation({
    mutationFn: (recipeId: string) =>
      cloudDeploymentsApi.deleteRecipe(selectedCompanyId!, recipeId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cloudDeployments.recipes(selectedCompanyId!) });
      pushToast({ title: "Recipe deleted", tone: "info" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to delete recipe", body: err.message, tone: "error" });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Cloud} message="Select a company to view cloud deployments." />;
  }

  if (deploymentsLoading) {
    return <PageSkeleton variant="list" />;
  }

  const deployments = deploymentsList ?? [];

  return (
    <div className="space-y-4">
      {/* Tab bar */}
      <div className="flex items-center gap-4 border-b border-border pb-2">
        <button
          onClick={() => setActiveTab("health")}
          className={`flex items-center gap-1.5 px-1 pb-2 text-sm font-medium transition-colors border-b-2 -mb-[10px] ${
            activeTab === "health"
              ? "text-foreground border-foreground"
              : "text-muted-foreground border-transparent hover:text-foreground"
          }`}
        >
          <Activity className="h-4 w-4" />
          Health Dashboard
        </button>
        <button
          onClick={() => setActiveTab("recipes")}
          className={`flex items-center gap-1.5 px-1 pb-2 text-sm font-medium transition-colors border-b-2 -mb-[10px] ${
            activeTab === "recipes"
              ? "text-foreground border-foreground"
              : "text-muted-foreground border-transparent hover:text-foreground"
          }`}
        >
          <ChefHat className="h-4 w-4" />
          Recipes
        </button>
      </div>

      {/* Health Dashboard Tab */}
      {activeTab === "health" && (
        <div className="space-y-4">
          {deployments.length === 0 && (
            <div className="flex flex-col items-center gap-4 py-12">
              <Cloud className="h-12 w-12 text-muted-foreground/40" />
              <h2 className="text-lg font-[var(--font-display)] uppercase tracking-[0.06em]">Cloud Deploy Health</h2>
              <p className="text-sm text-muted-foreground max-w-lg text-center">
                Cloud Deploy monitors the health and uptime of your live deployments across AWS, GCP, Azure,
                and other providers. Set up automated health checks, view status dashboards, and trigger
                one-click rollbacks when issues are detected.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-xl text-xs text-muted-foreground">
                <div className="hud-panel rounded-[2px] border border-border p-3 space-y-1">
                  <p className="font-medium text-foreground">Health Monitoring</p>
                  <p>Automated health checks with real-time status dashboards for all deployments</p>
                </div>
                <div className="hud-panel rounded-[2px] border border-border p-3 space-y-1">
                  <p className="font-medium text-foreground">One-Click Rollback</p>
                  <p>Instantly rollback to a previous version when a deployment goes unhealthy</p>
                </div>
                <div className="hud-panel rounded-[2px] border border-border p-3 space-y-1">
                  <p className="font-medium text-foreground">Multi-Cloud</p>
                  <p>Manage deployments across AWS, GCP, Azure, and custom providers in one view</p>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">Create a deployment from the <strong>Deployments</strong> page first, then monitor it here.</p>
            </div>
          )}

          {deployments.length > 0 && (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-4 gap-3">
                {(["healthy", "degraded", "unhealthy", "unknown"] as const).map((status) => {
                  const count = deployments.filter(
                    (d) => d.healthStatus === status,
                  ).length;
                  const unknownCount =
                    status === "unknown"
                      ? deployments.filter(
                          (d) => !d.healthStatus || d.healthStatus === "unknown",
                        ).length
                      : count;
                  return (
                    <div
                      key={status}
                      className="hud-panel rounded-[2px] border border-border bg-card p-3"
                    >
                      <div className="text-xs text-muted-foreground capitalize">{status}</div>
                      <div className="text-2xl font-bold mt-1">
                        {status === "unknown" ? unknownCount : count}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Deployment health table */}
              <div className="rounded-[2px] border border-border overflow-hidden overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/30">
                      <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Environment</th>
                      <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Status</th>
                      <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Health</th>
                      <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Provider</th>
                      <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Cloud</th>
                      <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Last Check</th>
                      <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">URL</th>
                      <th className="text-right px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deployments.map((d) => {
                      const ext = d;
                      return (
                        <tr key={d.id} className="border-b border-border last:border-0 hover:bg-[var(--sidebar-accent)] transition-colors">
                          <td className="px-4 py-3">
                            <span className="text-xs font-medium">{d.environment}</span>
                            {ext.version && (
                              <span className="ml-1.5 text-xs text-muted-foreground">{ext.version}</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <HealthBadge status={d.status} />
                          </td>
                          <td className="px-4 py-3">
                            <HealthBadge status={ext.healthStatus ?? "unknown"} />
                          </td>
                          <td className="px-4 py-3">
                            {d.provider ?? "-"}
                          </td>
                          <td className="px-4 py-3">
                            <ProviderBadge provider={ext.cloudProvider ?? null} />
                            {ext.cloudRegion && (
                              <span className="ml-1 text-xs text-muted-foreground">{ext.cloudRegion}</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {ext.healthCheckedAt ? formatRelativeTime(ext.healthCheckedAt) : "never"}
                            {ext.healthMessage && (
                              <span className="block text-xs text-muted-foreground/70 truncate max-w-[180px]" title={ext.healthMessage}>
                                {ext.healthMessage}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {d.url ? (
                              <a
                                href={d.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-xs text-[var(--status-info)] hover:underline"
                              >
                                <ExternalLink className="h-3 w-3" />
                                Visit
                              </a>
                            ) : (
                              <span className="text-muted-foreground text-xs">-</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                title="Run health check"
                                disabled={!d.url || healthCheckMutation.isPending}
                                onClick={() => healthCheckMutation.mutate({ deploymentId: d.id })}
                              >
                                <Heart className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                title="View health history"
                                onClick={() =>
                                  setSelectedDeploymentId(
                                    selectedDeploymentId === d.id ? null : d.id,
                                  )
                                }
                              >
                                <Activity className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                title="Deploy to cloud"
                                onClick={() =>
                                  setShowCloudDeploy(showCloudDeploy === d.id ? null : d.id)
                                }
                              >
                                <Cloud className="h-3.5 w-3.5" />
                              </Button>
                              <Button
                                size="icon-sm"
                                variant="ghost"
                                title="Rollback"
                                disabled={rollbackMutation.isPending}
                                onClick={() => setRollbackTarget(d.id)}
                              >
                                <Undo2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Health check history panel */}
              {selectedDeploymentId && (
                <HealthCheckHistory
                  companyId={selectedCompanyId}
                  deploymentId={selectedDeploymentId}
                  onClose={() => setSelectedDeploymentId(null)}
                />
              )}

              {/* Cloud deploy panel */}
              {showCloudDeploy && (
                <CloudDeployDialog
                  companyId={selectedCompanyId}
                  deploymentId={showCloudDeploy}
                  onClose={() => setShowCloudDeploy(null)}
                />
              )}

              {/* Mutation errors */}
              {healthCheckMutation.error && (
                <p className="text-xs text-destructive">{healthCheckMutation.error.message}</p>
              )}
              {rollbackMutation.error && (
                <p className="text-xs text-destructive">{rollbackMutation.error.message}</p>
              )}
            </>
          )}
        </div>
      )}

      <AlertDialog open={!!rollbackTarget} onOpenChange={(open) => { if (!open) setRollbackTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rollback deployment</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to rollback this deployment? This will revert to the previous version.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (rollbackTarget) rollbackMutation.mutate({ deploymentId: rollbackTarget });
                setRollbackTarget(null);
              }}
            >
              Rollback
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteRecipeTarget} onOpenChange={(open) => { if (!open) setDeleteRecipeTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete recipe</AlertDialogTitle>
            <AlertDialogDescription>
              Delete recipe &ldquo;{deleteRecipeTarget?.name}&rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteRecipeTarget) deleteRecipeMutation.mutate(deleteRecipeTarget.id);
                setDeleteRecipeTarget(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Recipes Tab */}
      {activeTab === "recipes" && (
        <div className="space-y-4">
          <div className="flex items-center justify-end">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setEditingRecipe(null);
                setShowRecipeForm(true);
              }}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Recipe
            </Button>
          </div>

          {(showRecipeForm || editingRecipe) && (
            <RecipeForm
              companyId={selectedCompanyId}
              recipe={editingRecipe ?? undefined}
              onClose={() => {
                setShowRecipeForm(false);
                setEditingRecipe(null);
              }}
            />
          )}

          {recipesLoading && <PageSkeleton variant="list" />}

          {recipes && recipes.length === 0 && !showRecipeForm && (
            <div className="flex flex-col items-center gap-4 py-12">
              <ChefHat className="h-12 w-12 text-muted-foreground/40" />
              <h2 className="text-lg font-[var(--font-display)] uppercase tracking-[0.06em]">Deployment Recipes</h2>
              <p className="text-sm text-muted-foreground max-w-lg text-center">
                Recipes are reusable deployment templates that define provider, region, resource limits, and
                environment variables. Create a recipe once, then use it to deploy consistently every time.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-md text-xs text-muted-foreground">
                <div className="hud-panel rounded-[2px] border border-border p-3 space-y-1">
                  <p className="font-medium text-foreground">Reusable Templates</p>
                  <p>Define provider, region, and config once — reuse across deployments</p>
                </div>
                <div className="hud-panel rounded-[2px] border border-border p-3 space-y-1">
                  <p className="font-medium text-foreground">One-Click Deploy</p>
                  <p>Trigger cloud deployments from a recipe with a single click</p>
                </div>
              </div>
              <Button size="sm" onClick={() => setShowRecipeForm(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                New Recipe
              </Button>
            </div>
          )}

          {recipes && recipes.length > 0 && (
            <div className="rounded-[2px] border border-border overflow-hidden overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30">
                    <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Name</th>
                    <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Provider</th>
                    <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Region</th>
                    <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Resource Type</th>
                    <th className="text-left px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Description</th>
                    <th className="text-right px-4 py-2.5 text-xs font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {recipes.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0 hover:bg-[var(--sidebar-accent)] transition-colors">
                      <td className="px-4 py-3 font-medium">{r.name}</td>
                      <td className="px-4 py-3">
                        <ProviderBadge provider={r.cloudProvider} />
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{r.cloudRegion}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.resourceType}</td>
                      <td className="px-4 py-3 text-muted-foreground truncate max-w-[200px]">
                        {r.description ?? "-"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="Edit recipe"
                            onClick={() => {
                              setEditingRecipe(r);
                              setShowRecipeForm(false);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            title="Delete recipe"
                            disabled={deleteRecipeMutation.isPending}
                            onClick={() => setDeleteRecipeTarget({ id: r.id, name: r.name })}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {deleteRecipeMutation.error && (
            <p className="text-xs text-destructive">{deleteRecipeMutation.error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
