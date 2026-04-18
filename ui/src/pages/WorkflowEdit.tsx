import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@/lib/router";
import { ArrowLeft, ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { workflowTemplatesApi } from "../api/workflow-templates";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WorkflowDAGView } from "../components/WorkflowDAGView";
import type { IssueExecutionPolicy, IssuePriority } from "@paperclipai/shared";
import { ISSUE_PRIORITIES } from "@paperclipai/shared";

interface NodeDraft {
  tempId: string;
  title: string;
  description: string;
  blockedByTempIds: string[];
  parentTempId: string | null;
  executionPolicy?: IssueExecutionPolicy | null;
  defaultAssigneeAgentId?: string | null;
  defaultPriority?: IssuePriority | null;
  _metaOpen?: boolean;
}

let nextId = 1;
function genTempId() {
  return `$node_${nextId++}`;
}

export function WorkflowEdit() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();

  const isNew = !id || id === "new";

  const { data: template, isLoading } = useQuery({
    queryKey: queryKeys.workflowTemplates.detail(id ?? ""),
    queryFn: () => workflowTemplatesApi.get(id!),
    enabled: !isNew && !!id,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [nodes, setNodes] = useState<NodeDraft[]>([]);
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([
      { label: "Workflows", href: "/workflows" },
      ...(isNew ? [{ label: "New Template" }] : [{ label: template?.name ?? "…", href: `/workflows/${id}` }, { label: "Edit" }]),
    ]);
  }, [setBreadcrumbs, isNew, template?.name, id]);

  // Seed form from template
  useEffect(() => {
    if (template) {
      setName(template.name);
      setDescription(template.description ?? "");
      setNodes(
        template.nodes.map((n) => ({
          tempId: n.tempId,
          title: n.title,
          description: n.description ?? "",
          blockedByTempIds: n.blockedByTempIds ?? [],
          parentTempId: n.parentTempId ?? null,
          executionPolicy: n.executionPolicy ?? null,
          defaultAssigneeAgentId: n.defaultAssigneeAgentId ?? null,
          defaultPriority: n.defaultPriority ?? null,
        })),
      );
    }
  }, [template]);

  const saveMutation = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      isNew
        ? workflowTemplatesApi.create(selectedCompanyId!, data)
        : workflowTemplatesApi.update(id!, data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.workflowTemplates.list(selectedCompanyId!) });
      if (!isNew) {
        queryClient.invalidateQueries({ queryKey: queryKeys.workflowTemplates.detail(id!) });
      }
      pushToast({ title: isNew ? "Template created" : "Template updated" });
      navigate(`/workflows/${result.id}`);
    },
  });

  function addNode() {
    setNodes((prev) => [
      ...prev,
      { tempId: genTempId(), title: "", description: "", blockedByTempIds: [], parentTempId: null },
    ]);
  }

  function removeNode(idx: number) {
    setNodes((prev) => {
      const removed = prev[idx];
      return prev
        .filter((_, i) => i !== idx)
        .map((n) => ({
          ...n,
          blockedByTempIds: n.blockedByTempIds.filter((bid) => bid !== removed.tempId),
          parentTempId: n.parentTempId === removed.tempId ? null : n.parentTempId,
        }));
    });
  }

  function updateNode(idx: number, patch: Partial<NodeDraft>) {
    setNodes((prev) => prev.map((n, i) => (i === idx ? { ...n, ...patch } : n)));
  }

  function handleSave() {
    if (!name.trim() || nodes.length === 0) return;
    const payload: Record<string, unknown> = {
      name: name.trim(),
      description: description.trim() || null,
      nodes: nodes.map((n) => ({
        tempId: n.tempId,
        title: n.title.trim(),
        description: n.description.trim() || null,
        blockedByTempIds: n.blockedByTempIds,
        parentTempId: n.parentTempId || undefined,
        executionPolicy: n.executionPolicy || undefined,
        defaultAssigneeAgentId: n.defaultAssigneeAgentId || undefined,
        defaultPriority: n.defaultPriority || undefined,
      })),
    };
    saveMutation.mutate(payload);
  }

  if (!isNew && isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate(isNew ? "/workflows" : `/workflows/${id}`)}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-xl font-semibold">{isNew ? "New Workflow Template" : "Edit Template"}</h1>
      </div>

      {/* Name / description */}
      <div className="space-y-3">
        <div>
          <label className="text-sm font-medium">Name</label>
          <input
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Agent Hiring SOP"
          />
        </div>
        <div>
          <label className="text-sm font-medium">Description</label>
          <textarea
            className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            rows={2}
          />
        </div>
      </div>

      {/* DAG preview */}
      {nodes.length > 0 && (
        <WorkflowDAGView
          nodes={nodes.map((n) => ({
            tempId: n.tempId,
            title: n.title || "Untitled",
            description: n.description || undefined,
            blockedByTempIds: n.blockedByTempIds,
            parentTempId: n.parentTempId,
          }))}
          minHeight={Math.min(350, Math.max(180, nodes.length * 50))}
        />
      )}

      {/* Node editor */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
            Nodes ({nodes.length})
          </h2>
          <Button variant="outline" size="sm" onClick={addNode}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add Node
          </Button>
        </div>

        <div className="space-y-3">
          {nodes.map((node, i) => (
            <Card key={node.tempId}>
              <CardContent className="py-3 px-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-muted-foreground">{node.tempId}</span>
                  <Button variant="ghost" size="icon-sm" onClick={() => removeNode(i)}>
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </div>
                <input
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                  value={node.title}
                  onChange={(e) => updateNode(i, { title: e.target.value })}
                  placeholder="Node title"
                />
                <textarea
                  className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                  value={node.description}
                  onChange={(e) => updateNode(i, { description: e.target.value })}
                  placeholder="Node description (issue body)"
                  rows={2}
                />
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-xs text-muted-foreground">Blocked by (comma-separated tempIds)</label>
                    <input
                      className="mt-0.5 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      value={node.blockedByTempIds.join(", ")}
                      onChange={(e) =>
                        updateNode(i, {
                          blockedByTempIds: e.target.value
                            .split(",")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="e.g. $root, $node_2"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="text-xs text-muted-foreground">Parent tempId</label>
                    <input
                      className="mt-0.5 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      value={node.parentTempId ?? ""}
                      onChange={(e) => updateNode(i, { parentTempId: e.target.value || null })}
                      placeholder="Optional parent"
                    />
                  </div>
                </div>

                {/* Collapsible metadata */}
                <div className="border-t border-border pt-1">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                    onClick={() => updateNode(i, { _metaOpen: !node._metaOpen })}
                  >
                    {node._metaOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Issue defaults
                    {(node.defaultAssigneeAgentId || node.defaultPriority || node.executionPolicy) && (
                      <span className="ml-1 w-1.5 h-1.5 rounded-full bg-primary" />
                    )}
                  </button>
                  {node._metaOpen && (
                    <div className="mt-1.5 space-y-2 rounded-md border border-border bg-muted/20 p-3">
                      <div className="flex gap-3">
                        <div className="flex-1">
                          <label className="text-xs text-muted-foreground">Default assignee</label>
                          <select
                            className="mt-0.5 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                            value={node.defaultAssigneeAgentId ?? ""}
                            onChange={(e) => updateNode(i, { defaultAssigneeAgentId: e.target.value || null })}
                          >
                            <option value="">None (use invoke default)</option>
                            {agents.map((a) => (
                              <option key={a.id} value={a.id}>
                                {a.icon ? `${a.icon} ` : ""}{a.name} — {a.title ?? a.role}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="w-36">
                          <label className="text-xs text-muted-foreground">Priority</label>
                          <select
                            className="mt-0.5 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm capitalize"
                            value={node.defaultPriority ?? ""}
                            onChange={(e) => updateNode(i, { defaultPriority: (e.target.value || null) as IssuePriority | null })}
                          >
                            <option value="">Default (medium)</option>
                            {ISSUE_PRIORITIES.map((p) => (
                              <option key={p} value={p} className="capitalize">{p}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-muted-foreground">Execution policy (JSON, optional)</label>
                        <input
                          className="mt-0.5 w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono"
                          value={node.executionPolicy ? JSON.stringify(node.executionPolicy) : ""}
                          onChange={(e) => {
                            if (!e.target.value) {
                              updateNode(i, { executionPolicy: null });
                              return;
                            }
                            try {
                              const parsed = JSON.parse(e.target.value);
                              updateNode(i, { executionPolicy: parsed });
                            } catch {
                              // Let user keep typing
                            }
                          }}
                          placeholder='e.g. {"autoAssign":true}'
                        />
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={() => navigate(isNew ? "/workflows" : `/workflows/${id}`)}>
          Cancel
        </Button>
        <Button
          onClick={handleSave}
          disabled={!name.trim() || nodes.length === 0 || saveMutation.isPending}
        >
          {saveMutation.isPending ? "Saving..." : "Save Template"}
        </Button>
      </div>
    </div>
  );
}
