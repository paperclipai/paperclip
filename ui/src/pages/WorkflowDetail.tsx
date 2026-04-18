import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@/lib/router";
import { ArrowLeft, Play, Pencil, Trash2 } from "lucide-react";
import { workflowTemplatesApi } from "../api/workflow-templates";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { WorkflowTemplateNode, WorkflowInvokeResponse } from "@paperclipai/shared";

export function WorkflowDetail() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs } = useBreadcrumbs();

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
          <Button size="sm" onClick={() => invokeMutation.mutate({})} disabled={invokeMutation.isPending}>
            <Play className="mr-1.5 h-4 w-4" />
            {invokeMutation.isPending ? "Invoking..." : "Invoke"}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive"
            onClick={() => deleteMutation.mutate()}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

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
