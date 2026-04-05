import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, useNavigate } from "@/lib/router";
import { ChevronDown, ChevronRight, Pencil, Trash2 } from "lucide-react";
import { workflowsApi } from "../api/workflows";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { formatDate } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { WorkflowDiagram } from "../components/workflow/WorkflowDiagram";
import { WorkflowStepTimeline } from "../components/workflow/WorkflowStepTimeline";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import type { WorkflowRunSummary, WorkflowRevision } from "@paperclipai/shared";

type Tab = "overview" | "runs" | "revisions";

function runStatusBadge(status: string) {
  const colors: Record<string, string> = {
    completed: "bg-green-500/10 text-green-600",
    running: "bg-blue-500/10 text-blue-600",
    pending: "bg-yellow-500/10 text-yellow-600",
    waiting_input: "bg-purple-500/10 text-purple-600",
    failed: "bg-red-500/10 text-red-600",
    cancelled: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-muted text-muted-foreground"}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ExpandableRun({ run }: { run: WorkflowRunSummary }) {
  const [open, setOpen] = useState(false);
  const { data: steps } = useQuery({
    queryKey: queryKeys.workflows.runSteps(run.id),
    queryFn: () => workflowsApi.getRunSteps(run.id),
    enabled: open,
  });

  return (
    <div className="border-b last:border-b-0">
      <button
        className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm hover:bg-accent/40 transition-colors"
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
        <span className="flex-1 font-medium">
          Run {run.id.slice(0, 8)}
        </span>
        {runStatusBadge(run.status)}
        <span className="text-xs text-muted-foreground">{timeAgo(run.createdAt)}</span>
      </button>
      {open && steps && (
        <div className="px-4 pb-4 pl-10">
          <WorkflowStepTimeline steps={steps} currentStepKey={run.currentStepKey} />
        </div>
      )}
    </div>
  );
}

export function WorkflowDetail() {
  const { workflowId } = useParams<{ workflowId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [editDraft, setEditDraft] = useState({
    name: "",
    description: "",
    definitionYaml: "",
    status: "",
  });

  const { data: workflow, isLoading } = useQuery({
    queryKey: queryKeys.workflows.detail(workflowId!),
    queryFn: () => workflowsApi.get(workflowId!),
    enabled: !!workflowId,
  });

  const { data: mermaidData } = useQuery({
    queryKey: queryKeys.workflows.mermaid(workflowId!),
    queryFn: () => workflowsApi.getMermaid(workflowId!),
    enabled: !!workflowId && tab === "overview",
  });

  const { data: runs } = useQuery({
    queryKey: queryKeys.workflows.runs(workflowId!),
    queryFn: () => workflowsApi.listRuns(workflowId!),
    enabled: !!workflowId && (tab === "runs" || tab === "overview"),
  });

  const { data: revisions } = useQuery({
    queryKey: queryKeys.workflows.revisions(workflowId!),
    queryFn: () => workflowsApi.listRevisions(workflowId!),
    enabled: !!workflowId && tab === "revisions",
  });

  const updateWorkflow = useMutation({
    mutationFn: () => {
      const patch: Record<string, unknown> = {};
      if (editDraft.name.trim() !== workflow?.name) patch.name = editDraft.name.trim();
      if ((editDraft.description.trim() || null) !== (workflow?.description ?? null)) {
        patch.description = editDraft.description.trim() || null;
      }
      if (editDraft.definitionYaml !== workflow?.definitionYaml) {
        patch.definitionYaml = editDraft.definitionYaml;
      }
      if (editDraft.status !== workflow?.status) patch.status = editDraft.status;
      return workflowsApi.update(workflowId!, patch);
    },
    onSuccess: async () => {
      setEditOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows.detail(workflowId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows.mermaid(workflowId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workflows.revisions(workflowId!) }),
        selectedCompanyId
          ? queryClient.invalidateQueries({ queryKey: queryKeys.workflows.list(selectedCompanyId) })
          : Promise.resolve(),
      ]);
      pushToast({ title: "Workflow updated", tone: "success" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update workflow",
        body: error instanceof Error ? error.message : "Something went wrong.",
        tone: "error",
      });
    },
  });

  const archiveWorkflow = useMutation({
    mutationFn: () => workflowsApi.archive(workflowId!),
    onSuccess: async () => {
      setDeleteOpen(false);
      if (selectedCompanyId) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.workflows.list(selectedCompanyId) });
      }
      pushToast({ title: "Workflow archived", tone: "success" });
      navigate("/workflows");
    },
    onError: (error) => {
      pushToast({
        title: "Failed to archive workflow",
        body: error instanceof Error ? error.message : "Something went wrong.",
        tone: "error",
      });
    },
  });

  useEffect(() => {
    if (!workflow) return;
    setBreadcrumbs([
      { label: "Workflows", href: "/workflows" },
      { label: workflow.name },
    ]);
  }, [workflow, setBreadcrumbs]);

  function openEditDialog() {
    if (!workflow) return;
    setEditDraft({
      name: workflow.name,
      description: workflow.description ?? "",
      definitionYaml: workflow.definitionYaml,
      status: workflow.status,
    });
    setEditOpen(true);
  }

  if (isLoading) return <PageSkeleton />;
  if (!workflow) return <div className="py-10 text-center text-sm text-muted-foreground">Workflow not found</div>;

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "runs", label: "Runs" },
    { key: "revisions", label: "Revisions" },
  ];

  const editCanSubmit = editDraft.name.trim().length > 0 && editDraft.definitionYaml.trim().length > 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{workflow.name}</h1>
            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              workflow.status === "active" ? "bg-green-500/10 text-green-600" :
              workflow.status === "draft" ? "bg-yellow-500/10 text-yellow-600" :
              "bg-muted text-muted-foreground"
            }`}>
              {workflow.status}
            </span>
          </div>
          {workflow.description && (
            <p className="mt-1 text-sm text-muted-foreground">{workflow.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={openEditDialog}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDeleteOpen(true)}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Archive
          </Button>
        </div>
      </div>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={(open) => { if (!open && !updateWorkflow.isPending) setEditOpen(false); }}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Edit Workflow</DialogTitle>
            <DialogDescription>Update the workflow definition and metadata.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="edit-wf-name">Name <span className="text-destructive">*</span></label>
              <input
                id="edit-wf-name"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={editDraft.name}
                onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="edit-wf-status">Status</label>
              <select
                id="edit-wf-status"
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                value={editDraft.status}
                onChange={(e) => setEditDraft((d) => ({ ...d, status: e.target.value }))}
              >
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="edit-wf-desc">Description</label>
              <textarea
                id="edit-wf-desc"
                className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y"
                rows={2}
                value={editDraft.description}
                onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="edit-wf-yaml">YAML Definition <span className="text-destructive">*</span></label>
              <textarea
                id="edit-wf-yaml"
                className="flex min-h-[160px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-y font-mono"
                rows={8}
                value={editDraft.definitionYaml}
                onChange={(e) => setEditDraft((d) => ({ ...d, definitionYaml: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={updateWorkflow.isPending}>
              Cancel
            </Button>
            <Button
              onClick={() => updateWorkflow.mutate()}
              disabled={!editCanSubmit || updateWorkflow.isPending}
            >
              {updateWorkflow.isPending ? "Saving..." : "Save changes"}
            </Button>
          </DialogFooter>
          {updateWorkflow.isError && (
            <p className="text-sm text-destructive">
              {updateWorkflow.error instanceof Error ? updateWorkflow.error.message : "Failed to update workflow"}
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete/Archive Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!open && !archiveWorkflow.isPending) setDeleteOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Archive Workflow</DialogTitle>
            <DialogDescription>
              Are you sure you want to archive <strong>{workflow.name}</strong>? This will soft-delete the workflow.
              It can be restored by changing its status back to active.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={archiveWorkflow.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => archiveWorkflow.mutate()}
              disabled={archiveWorkflow.isPending}
            >
              {archiveWorkflow.isPending ? "Archiving..." : "Archive workflow"}
            </Button>
          </DialogFooter>
          {archiveWorkflow.isError && (
            <p className="text-sm text-destructive">
              {archiveWorkflow.error instanceof Error ? archiveWorkflow.error.message : "Failed to archive workflow"}
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.key
                ? "border-b-2 border-foreground text-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "overview" && (
        <div className="space-y-6">
          {/* YAML Definition */}
          {workflow.definitionYaml && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Definition (YAML)</h3>
              <pre className="overflow-x-auto rounded-lg border bg-muted/30 p-4 text-xs font-mono whitespace-pre-wrap">
                {workflow.definitionYaml}
              </pre>
            </div>
          )}

          {mermaidData?.mermaid && (
            <WorkflowDiagram source={mermaidData.mermaid} title="Workflow Diagram" />
          )}

          {/* Assigned agents */}
          {workflow.assignments.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Assigned Agents</h3>
              <div className="flex flex-wrap gap-2">
                {workflow.assignments.map((a) => (
                  <span key={a.id} className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium">
                    {a.name} ({a.role})
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Recent runs */}
          {runs && runs.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Recent Runs</h3>
              <div className="rounded-lg border">
                {runs.slice(0, 5).map((run: WorkflowRunSummary) => (
                  <ExpandableRun key={run.id} run={run} />
                ))}
              </div>
            </div>
          )}

          {/* Graph structure */}
          {workflow.compiledGraph && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">Steps</h3>
              <div className="space-y-1">
                {workflow.compiledGraph.steps.map((step) => (
                  <div key={step.key} className="flex items-center gap-2 rounded border px-3 py-2 text-sm">
                    <span className="font-medium">{step.name}</span>
                    <span className="text-xs text-muted-foreground">({step.type})</span>
                    {step.description && (
                      <span className="ml-auto text-xs text-muted-foreground truncate max-w-xs">{step.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "runs" && (
        <div>
          {!runs?.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No runs yet</p>
          ) : (
            <div className="rounded-lg border">
              {runs.map((run: WorkflowRunSummary) => (
                <ExpandableRun key={run.id} run={run} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "revisions" && (
        <div>
          {!revisions?.length ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No revisions</p>
          ) : (
            <div className="rounded-lg border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30 text-left text-xs font-medium text-muted-foreground">
                    <th className="px-4 py-2">Version</th>
                    <th className="px-4 py-2">Change Summary</th>
                    <th className="px-4 py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {revisions.map((rev: WorkflowRevision) => (
                    <tr key={rev.id} className="border-b last:border-b-0">
                      <td className="px-4 py-3 font-medium">v{rev.version}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {rev.changeSummary ?? "No summary"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{formatDate(rev.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
