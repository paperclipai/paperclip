import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { GitBranch, MoreHorizontal, Play, Plus, Trash2 } from "lucide-react";
import { workflowTemplatesApi } from "../api/workflow-templates";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import type { WorkflowInvokeResponse } from "@paperclipai/shared";

export function Workflows() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs } = useBreadcrumbs();

  const [showCreate, setShowCreate] = useState(false);
  const [showInvoke, setShowInvoke] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Workflows" }]);
  }, [setBreadcrumbs]);

  const { data: templates, isLoading } = useQuery({
    queryKey: queryKeys.workflowTemplates.list(selectedCompanyId!),
    queryFn: () => workflowTemplatesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => workflowTemplatesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workflowTemplates.list(selectedCompanyId!) });
      pushToast({ title: "Template deleted" });
    },
  });

  const invokeMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      workflowTemplatesApi.invoke(id, data),
    onSuccess: (result: WorkflowInvokeResponse) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      pushToast({
        title: `Workflow invoked — ${result.createdIssues.length} issues created`,
      });
      setShowInvoke(null);
      navigate(`/issues/${result.rootIssueId}`);
    },
  });

  if (isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Workflows</h1>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          New Template
        </Button>
      </div>

      {!templates?.length ? (
        <EmptyState
          icon={GitBranch}
          message="No workflow templates yet. Create one to define reusable multi-step processes."
        />
      ) : (
        <div className="rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Name</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Description</th>
                <th className="px-4 py-2 text-center font-medium text-muted-foreground">Nodes</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Created</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {templates.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-accent/30">
                  <td className="px-4 py-2">
                    <Link to={`/workflows/${t.id}`} className="font-medium hover:underline">
                      {t.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground truncate max-w-xs">
                    {t.description || "—"}
                  </td>
                  <td className="px-4 py-2 text-center">{t.nodes.length}</td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-2">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => setShowInvoke(t.id)}
                        >
                          <Play className="mr-2 h-4 w-4" />
                          Invoke
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => navigate(`/workflows/${t.id}/edit`)}
                        >
                          Edit
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => deleteMutation.mutate(t.id)}
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Quick invoke dialog */}
      <Dialog open={!!showInvoke} onOpenChange={() => setShowInvoke(null)}>
        <DialogContent>
          <h2 className="text-lg font-semibold mb-4">Invoke Workflow</h2>
          <p className="text-sm text-muted-foreground mb-4">
            This will create a new issue tree from the template.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowInvoke(null)}>Cancel</Button>
            <Button
              onClick={() => showInvoke && invokeMutation.mutate({ id: showInvoke, data: {} })}
              disabled={invokeMutation.isPending}
            >
              {invokeMutation.isPending ? "Invoking..." : "Invoke"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Create dialog */}
      {showCreate && (
        <CreateWorkflowTemplateDialog
          companyId={selectedCompanyId!}
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            queryClient.invalidateQueries({ queryKey: queryKeys.workflowTemplates.list(selectedCompanyId!) });
          }}
        />
      )}
    </div>
  );
}

function CreateWorkflowTemplateDialog({
  companyId,
  onClose,
  onCreated,
}: {
  companyId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { pushToast } = useToastActions();

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      workflowTemplatesApi.create(companyId, data),
    onSuccess: () => {
      pushToast({ title: "Template created" });
      onCreated();
    },
  });

  function handleSubmit() {
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      description: description.trim() || null,
      nodes: [
        {
          tempId: "$root",
          title: name.trim(),
          description: description.trim() || null,
          blockedByTempIds: [],
        },
      ],
    });
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent>
        <h2 className="text-lg font-semibold mb-4">Create Workflow Template</h2>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Name</label>
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Agent Hiring SOP"
              autoFocus
            />
          </div>
          <div>
            <label className="text-sm font-medium">Description</label>
            <textarea
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional description"
              rows={3}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!name.trim() || createMutation.isPending}>
            {createMutation.isPending ? "Creating..." : "Create"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
