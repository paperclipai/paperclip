import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { GitBranch, Plus } from "lucide-react";
import { workflowsApi } from "../api/workflows";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { WorkflowListItem } from "@paperclipai/shared";

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    active: "bg-green-500/10 text-green-600",
    draft: "bg-yellow-500/10 text-yellow-600",
    archived: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? colors.draft}`}>
      {status}
    </span>
  );
}

function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function Workflows() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    slug: "",
    description: "",
    definitionYaml: "",
  });
  const [slugManuallyEdited, setSlugManuallyEdited] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows" }]);
  }, [setBreadcrumbs]);

  const { data: workflows, isLoading } = useQuery({
    queryKey: queryKeys.workflows.list(selectedCompanyId!),
    queryFn: () => workflowsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const createWorkflow = useMutation({
    mutationFn: () =>
      workflowsApi.create(selectedCompanyId!, {
        name: draft.name.trim(),
        slug: draft.slug || nameToSlug(draft.name),
        description: draft.description.trim() || null,
        definitionYaml: draft.definitionYaml,
      }),
    onSuccess: async (workflow) => {
      setDraft({ name: "", slug: "", description: "", definitionYaml: "" });
      setSlugManuallyEdited(false);
      setCreateOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.workflows.list(selectedCompanyId!) });
      pushToast({ title: "Workflow created", body: `${workflow.name} is ready.`, tone: "success" });
      navigate(`/workflows/${workflow.id}`);
    },
    onError: (error) => {
      pushToast({
        title: "Failed to create workflow",
        body: error instanceof Error ? error.message : "Something went wrong.",
        tone: "error",
      });
    },
  });

  function resetAndClose() {
    if (!createWorkflow.isPending) {
      setDraft({ name: "", slug: "", description: "", definitionYaml: "" });
      setSlugManuallyEdited(false);
      setCreateOpen(false);
    }
  }

  const slugValue = slugManuallyEdited ? draft.slug : nameToSlug(draft.name);
  const canSubmit = draft.name.trim().length > 0 && draft.definitionYaml.trim().length > 0 && slugValue.length > 0;

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Create workflow
        </Button>
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) resetAndClose(); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Create Workflow</DialogTitle>
            <DialogDescription>Define a new workflow with a YAML definition.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="wf-name">Name <span className="text-destructive">*</span></label>
              <input
                id="wf-name"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                placeholder="My Workflow"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="wf-slug">Slug</label>
              <input
                id="wf-slug"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring font-mono"
                placeholder="my-workflow"
                value={slugValue}
                onChange={(e) => {
                  setSlugManuallyEdited(true);
                  setDraft((d) => ({ ...d, slug: e.target.value }));
                }}
              />
              <p className="text-xs text-muted-foreground">Lowercase, alphanumeric with hyphens. Auto-generated from name.</p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="wf-desc">Description</label>
              <textarea
                id="wf-desc"
                className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                placeholder="What does this workflow do?"
                rows={2}
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="wf-yaml">YAML Definition <span className="text-destructive">*</span></label>
              <textarea
                id="wf-yaml"
                className="flex min-h-[160px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y font-mono"
                placeholder={"steps:\n  - key: start\n    name: Start\n    type: agent_task"}
                rows={8}
                value={draft.definitionYaml}
                onChange={(e) => setDraft((d) => ({ ...d, definitionYaml: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={resetAndClose} disabled={createWorkflow.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => createWorkflow.mutate()}
              disabled={!canSubmit || createWorkflow.isPending}
            >
              <Plus className="mr-2 h-4 w-4" />
              {createWorkflow.isPending ? "Creating..." : "Create workflow"}
            </Button>
          </DialogFooter>
          {createWorkflow.isError && (
            <p className="text-sm text-destructive">
              {createWorkflow.error instanceof Error ? createWorkflow.error.message : "Failed to create workflow"}
            </p>
          )}
        </DialogContent>
      </Dialog>

      {!workflows?.length ? (
        <EmptyState
          icon={GitBranch}
          message="No workflows yet. Create one to get started."
        />
      ) : (
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30 text-left text-xs font-medium text-muted-foreground">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Agents</th>
                <th className="px-4 py-2 text-right">Active Runs</th>
                <th className="px-4 py-2">Last Run</th>
                <th className="px-4 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((wf: WorkflowListItem) => (
                <tr
                  key={wf.id}
                  className="cursor-pointer border-b last:border-b-0 hover:bg-accent/40 transition-colors"
                  onClick={() => navigate(`/workflows/${wf.id}`)}
                >
                  <td className="px-4 py-3 font-medium">{wf.name}</td>
                  <td className="px-4 py-3">{statusBadge(wf.status)}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{wf.assignmentCount}</td>
                  <td className="px-4 py-3 text-right text-muted-foreground">{wf.activeRunCount}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {wf.lastRun ? timeAgo(wf.lastRun.createdAt) : "Never"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{timeAgo(wf.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
