import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { companyTemplatesApi } from "../api/companyTemplates";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader2, Rocket, Building2, AlertCircle, CheckCircle2 } from "lucide-react";
import { usePageMeta } from "../hooks/usePageMeta";

export function CompanyTemplates() {
  const { setBreadcrumbs } = useBreadcrumbs();
  usePageMeta("Templates", "Manage reusable templates for your company.");
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [deployKey, setDeployKey] = useState<string | null>(null);
  const [deployName, setDeployName] = useState("");
  const [showDeployDialog, setShowDeployDialog] = useState(false);

  const { data: templates, isLoading, error } = useQuery({
    queryKey: queryKeys.companyTemplates.list,
    queryFn: () => companyTemplatesApi.list(),
  });

  const deployMutation = useMutation({
    mutationFn: ({ key, name }: { key: string; name?: string }) =>
      companyTemplatesApi.deploy(key, name ? { name } : undefined),
    onSuccess: (result) => {
      pushToast({ title: `Company "${result.company.name}" created from template!`, tone: "success" });
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      setShowDeployDialog(false);
      setDeployKey(null);
      // Full page load so the company context refreshes to include the new company.
      window.location.assign(`/${result.company.issuePrefix}/dashboard`);
    },
    onError: (err: Error) => {
      pushToast({ title: `Failed to deploy template: ${err.message}`, tone: "error" });
    },
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Company Templates" }]);
  }, [setBreadcrumbs]);

  function openDeploy(key: string, defaultName: string) {
    setDeployKey(key);
    setDeployName(defaultName);
    setShowDeployDialog(true);
  }

  function handleDeploy() {
    if (!deployKey) return;
    deployMutation.mutate({ key: deployKey, name: deployName || undefined });
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-muted-foreground">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p>Failed to load templates. Please try again.</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Company Templates</h1>
        <p className="mt-2 text-muted-foreground">
          Pre-built companies for common use cases. Deploy one in seconds and
          customize it after launch.
        </p>
      </div>

      {templates && templates.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-muted-foreground">
          <Building2 className="h-10 w-10" />
          <p className="text-lg font-medium">No templates available</p>
          <p className="text-sm">Check back later for new templates.</p>
        </div>
      ) : (
        <div className="grid gap-6 sm:grid-cols-2">
          {templates?.map((tmpl) => (
            <div
              key={tmpl.key}
              className="group relative flex flex-col rounded-lg border bg-card p-6 shadow-sm transition-all hover:shadow-md"
            >
              {/* Icon + header */}
              <div className="mb-4 flex items-start gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-muted text-2xl">
                  {tmpl.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-lg font-semibold leading-tight">
                    {tmpl.name}
                  </h3>
                  <p className="mt-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {tmpl.industry}
                  </p>
                </div>
              </div>

              {/* Description */}
              <p className="mb-4 line-clamp-3 text-sm text-muted-foreground">
                {tmpl.description}
              </p>

              {/* Company preview */}
              <div className="mb-4 rounded-md bg-muted/40 p-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <Building2 className="h-4 w-4 text-muted-foreground" />
                  {tmpl.company.name}
                </div>
                {tmpl.company.description && (
                  <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                    {tmpl.company.description}
                  </p>
                )}
              </div>

              {/* Spacer */}
              <div className="flex-1" />

              {/* Action */}
              <Button
                onClick={() => openDeploy(tmpl.key, tmpl.company.name)}
                className="mt-4 w-full"
              >
                <Rocket className="mr-2 h-4 w-4" />
                Deploy {tmpl.name}
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Deploy confirmation dialog */}
      <Dialog open={showDeployDialog} onOpenChange={setShowDeployDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deploy Company Template</DialogTitle>
            <DialogDescription>
              This will create a new company with pre-configured agents, skills,
              and starter content. The company is fully customizable after
              deployment.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label
                htmlFor="deploy-name"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                Company Name
              </label>
              <Input
                id="deploy-name"
                value={deployName}
                onChange={(e) => setDeployName(e.target.value)}
                placeholder="Enter a name for your company"
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to use the template&apos;s default name.
              </p>
            </div>

            {deployMutation.isSuccess && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                Company created! Redirecting to your board...
              </div>
            )}

            {deployMutation.isError && (
              <div className="flex items-center gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {deployMutation.error?.message ?? "Deployment failed. Please try again."}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowDeployDialog(false);
                setDeployKey(null);
                deployMutation.reset();
              }}
              disabled={deployMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleDeploy}
              disabled={deployMutation.isPending}
            >
              {deployMutation.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <Rocket className="mr-2 h-4 w-4" />
                  Deploy
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}