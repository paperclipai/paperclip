import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@/lib/router";
import { ArrowLeft, Play, Pencil, Trash2 } from "lucide-react";
import { workflowTemplatesApi } from "../api/workflow-templates";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { PageSkeleton } from "../components/PageSkeleton";
import { MarkdownEditor } from "../components/MarkdownEditor";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { AgentIcon } from "../components/AgentIconPicker";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { WorkflowDAGView } from "../components/WorkflowDAGView";
import type { WorkflowTemplateNode, WorkflowInvokeResponse } from "@paperclipai/shared";

export function WorkflowDetail() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [showInvoke, setShowInvoke] = useState(false);
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

  const { data: template, isLoading } = useQuery({
    queryKey: queryKeys.workflowTemplates.detail(id!),
    queryFn: () => workflowTemplatesApi.get(id!),
    enabled: !!id,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Workflows", href: "/workflows" },
      { label: template?.name ?? "…" },
    ]);
  }, [setBreadcrumbs, template?.name]);

  const invokeMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      workflowTemplatesApi.invoke(id!, data),
    onSuccess: (result: WorkflowInvokeResponse) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      pushToast({
        title: `Workflow invoked — ${result.createdIssues.length} issues created`,
      });
      navigate(`/issues/${result.rootIssueId}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => workflowTemplatesApi.remove(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workflowTemplates.list(selectedCompanyId!) });
      pushToast({ title: "Template deleted" });
      navigate("/workflows");
    },
  });

  if (isLoading || !template) return <PageSkeleton />;

  // Build lookup for node names
  const nodeMap = new Map(template.nodes.map((n) => [n.tempId, n]));

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate("/workflows")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{template.name}</h1>
          {template.description && (
            <p className="text-sm text-muted-foreground mt-1">{template.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => navigate(`/workflows/${id}/edit`)}>
            <Pencil className="mr-1.5 h-4 w-4" />
            Edit
          </Button>
          <Button size="sm" onClick={() => setShowInvoke(true)} disabled={invokeMutation.isPending}>
            <Play className="mr-1.5 h-4 w-4" />
            {invokeMutation.isPending ? "Invoking..." : "Invoke"}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive"
            onClick={() => {
              if (!window.confirm("Delete this workflow template? Linked routines will be detached.")) return;
              deleteMutation.mutate();
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* DAG visualization */}
      <WorkflowDAGView nodes={template.nodes} minHeight={Math.min(400, Math.max(200, template.nodes.length * 60))} />

      {/* Node list */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground mb-3 uppercase tracking-wider">
          Nodes ({template.nodes.length})
        </h2>
        <div className="space-y-2">
          {template.nodes.map((node, i) => (
            <NodeCard key={node.tempId} node={node} index={i} nodeMap={nodeMap} />
          ))}
        </div>
      </div>

      {/* Invoke dialog */}
      <Dialog open={showInvoke} onOpenChange={(open) => { if (!open) { setShowInvoke(false); setInvokeContext(""); setInvokeAgentId(""); } }}>
        <DialogContent>
          <h2 className="text-lg font-semibold mb-4">Invoke: {template.name}</h2>
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
            <Button variant="outline" onClick={() => { setShowInvoke(false); setInvokeContext(""); setInvokeAgentId(""); }}>Cancel</Button>
            <Button
              onClick={() => {
                invokeMutation.mutate({
                  ...(invokeContext.trim() ? { context: invokeContext.trim() } : {}),
                  ...(invokeAgentId ? { defaultAssigneeAgentId: invokeAgentId } : {}),
                });
                setShowInvoke(false);
                setInvokeContext("");
                setInvokeAgentId("");
              }}
              disabled={invokeMutation.isPending}
            >
              {invokeMutation.isPending ? "Invoking..." : "Invoke"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Metadata */}
      <div className="text-xs text-muted-foreground space-y-1">
        <p>Created: {new Date(template.createdAt).toLocaleString()}</p>
        {template.updatedAt && <p>Updated: {new Date(template.updatedAt).toLocaleString()}</p>}
      </div>
    </div>
  );
}

function NodeCard({
  node,
  index,
  nodeMap,
}: {
  node: WorkflowTemplateNode;
  index: number;
  nodeMap: Map<string, WorkflowTemplateNode>;
}) {
  const blockerNames = (node.blockedByTempIds ?? [])
    .map((id) => nodeMap.get(id)?.title ?? id)
    .join(", ");

  const parentName = node.parentTempId ? nodeMap.get(node.parentTempId)?.title ?? node.parentTempId : null;

  return (
    <Card>
      <CardContent className="py-3 px-4">
        <div className="flex items-start gap-3">
          <span className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full bg-muted text-xs font-medium">
            {index + 1}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">{node.title}</span>
              <code className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {node.tempId}
              </code>
              {node.executionPolicy && (
                <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                  {node.executionPolicy.mode}
                </span>
              )}
            </div>
            {node.description && (
              <p className="text-sm text-muted-foreground mt-1">{node.description}</p>
            )}
            <div className="flex flex-wrap gap-3 mt-1.5 text-xs text-muted-foreground">
              {blockerNames && <span>Blocked by: {blockerNames}</span>}
              {parentName && <span>Parent: {parentName}</span>}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
