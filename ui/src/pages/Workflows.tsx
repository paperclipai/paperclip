import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@/lib/router";
import { GitBranch, MoreHorizontal, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { workflowTemplatesApi } from "../api/workflow-templates";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { AgentIcon } from "../components/AgentIconPicker";
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
  const [invokeContext, setInvokeContext] = useState("");
  const [invokeAgentId, setInvokeAgentId] = useState("");

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects = [] } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      agents
        .filter((a) => a.status !== "terminated")
        .map((a) => ({
          id: a.id,
          label: a.name,
          searchText: `${a.name} ${a.role} ${a.title ?? ""}`,
        })),
    [agents],
  );

  const mentionOptions = useMemo(
    () => buildMarkdownMentionOptions({ agents, projects }),
    [agents, projects],
  );

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
      setInvokeContext("");
      setInvokeAgentId("");
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
                          <Pencil className="mr-2 h-4 w-4" />
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

      {/* Invoke dialog */}
      <Dialog open={!!showInvoke} onOpenChange={(open) => { if (!open) { setShowInvoke(null); setInvokeContext(""); setInvokeAgentId(""); } }}>
        <DialogContent>
          <h2 className="text-lg font-semibold mb-4">Invoke Workflow</h2>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium">Context / prompt</label>
              <div className="mt-1 rounded-md border border-border">
                <MarkdownEditor
                  value={invokeContext}
                  onChange={setInvokeContext}
                  placeholder="Describe what this run is for — use @mention to reference agents or projects"
                  mentions={mentionOptions}
                  contentClassName="text-sm min-h-[100px]"
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                This context will be prepended to every issue description in the workflow.
              </p>
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Default assignee</label>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="text-xs shrink-0">For</span>
                <InlineEntitySelector
                  value={invokeAgentId}
                  options={assigneeOptions}
                  placeholder="Assignee"
                  noneLabel="No assignee (use node defaults)"
                  searchPlaceholder="Search agents..."
                  emptyMessage="No agents found."
                  disablePortal
                  onChange={setInvokeAgentId}
                  renderTriggerValue={(option) => {
                    if (!option) return <span className="text-muted-foreground">Assignee</span>;
                    const agent = agents.find((a) => a.id === option.id);
                    return (
                      <>
                        {agent && <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <span className="truncate">{option.label}</span>
                      </>
                    );
                  }}
                  renderOption={(option) => {
                    const agent = agents.find((a) => a.id === option.id);
                    return (
                      <>
                        {agent && <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                        <span className="truncate">{option.label}</span>
                      </>
                    );
                  }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                Assigned to issues that don't have a per-node agent configured.
              </p>
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => { setShowInvoke(null); setInvokeContext(""); setInvokeAgentId(""); }}>Cancel</Button>
            <Button
              onClick={() => showInvoke && invokeMutation.mutate({
                id: showInvoke,
                data: {
                  ...(invokeContext.trim() ? { context: invokeContext.trim() } : {}),
                  ...(invokeAgentId ? { defaultAssigneeAgentId: invokeAgentId } : {}),
                },
              })}
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
          onCreated={(id) => {
            setShowCreate(false);
            queryClient.invalidateQueries({ queryKey: queryKeys.workflowTemplates.list(selectedCompanyId!) });
            navigate(`/workflows/${id}/edit`);
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
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { pushToast } = useToastActions();

  const createMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      workflowTemplatesApi.create(companyId, data),
    onSuccess: (result) => {
      pushToast({ title: "Template created" });
      onCreated(result.id);
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
