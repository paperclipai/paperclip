import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@/lib/router";
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Minus,
  Plus,
  Trash2,
} from "lucide-react";
import { workflowTemplatesApi } from "../api/workflow-templates";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { priorityColor, priorityColorDefault } from "../lib/status-colors";
import { cn } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { AgentIcon } from "../components/AgentIconPicker";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { buildExecutionPolicy, stageParticipantValues } from "../lib/issue-execution-policy";
import { WorkflowDAGView } from "../components/WorkflowDAGView";
import type { IssueExecutionPolicy, IssuePriority } from "@paperclipai/shared";

interface NodeDraft {
  tempId: string;
  title: string;
  description: string;
  blockedByTempIds: string[];
  parentTempId: string | null;
  executionPolicy?: IssueExecutionPolicy | null;
  defaultAssigneeAgentId?: string | null;
  defaultPriority?: IssuePriority | null;
  defaultProjectId?: string | null;
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

  const projectOptions = useMemo<InlineEntityOption[]>(
    () => projects.map((p) => ({ id: p.id, label: p.name, searchText: p.description ?? "" })),
    [projects],
  );

  const priorityItems = useMemo(
    () => [
      { value: "critical" as const, label: "Critical", icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault },
      { value: "high" as const, label: "High", icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault },
      { value: "medium" as const, label: "Medium", icon: Minus, color: priorityColor.medium ?? priorityColorDefault },
      { value: "low" as const, label: "Low", icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault },
    ],
    [],
  );

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
          defaultProjectId: n.defaultProjectId ?? null,
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
        defaultProjectId: n.defaultProjectId || undefined,
      })),
    };
    saveMutation.mutate(payload);
  }

  if (!isNew && isLoading) return <PageSkeleton />;

  return (
    <div className="space-y-6">
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

        <div className="grid grid-cols-1 md:grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
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
                  rows={5}
                />
                <div className="flex gap-3">
                  <div className="flex-1 flex flex-col">
                    <label className="text-xs text-muted-foreground mb-0.5">Blocked by</label>
                    <input
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
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
                  <div className="flex-1 flex flex-col">
                    <label className="text-xs text-muted-foreground mb-0.5">Parent tempId</label>
                    <input
                      className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm"
                      value={node.parentTempId ?? ""}
                      onChange={(e) => updateNode(i, { parentTempId: e.target.value || null })}
                      placeholder="Optional parent"
                    />
                  </div>
                </div>

                {/* Collapsible metadata — matches issue creation style */}
                <div className="border-t border-border pt-1">
                  <button
                    type="button"
                    className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors py-1"
                    onClick={() => updateNode(i, { _metaOpen: !node._metaOpen })}
                  >
                    {node._metaOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    Issue defaults
                    {(node.defaultAssigneeAgentId || node.defaultPriority || node.defaultProjectId || node.executionPolicy) && (
                      <span className="ml-1 w-1.5 h-1.5 rounded-full bg-primary" />
                    )}
                  </button>
                  {node._metaOpen && (
                    <div className="mt-1.5 rounded-md border border-border bg-muted/20 p-3 space-y-3">
                      {/* Assignee + Project row — "For [agent] in [project]" like NewIssueDialog */}
                      <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                        <span className="text-xs shrink-0">For</span>
                        <InlineEntitySelector
                          value={node.defaultAssigneeAgentId ?? ""}
                          options={assigneeOptions}
                          placeholder="Assignee"
                          noneLabel="No assignee (use invoke default)"
                          searchPlaceholder="Search agents..."
                          emptyMessage="No agents found."
                          onChange={(val) => updateNode(i, { defaultAssigneeAgentId: val || null })}
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
                        <span className="text-xs shrink-0">in</span>
                        <InlineEntitySelector
                          value={node.defaultProjectId ?? ""}
                          options={projectOptions}
                          placeholder="Project"
                          noneLabel="No project"
                          searchPlaceholder="Search projects..."
                          emptyMessage="No projects found."
                          onChange={(val) => updateNode(i, { defaultProjectId: val || null })}
                          renderTriggerValue={(option) => {
                            if (!option) return <span className="text-muted-foreground">Project</span>;
                            const project = projects.find((p) => p.id === option.id);
                            return (
                              <>
                                {project && (
                                  <span
                                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                                    style={{ backgroundColor: (project as any).color ?? "#6366f1" }}
                                  />
                                )}
                                <span className="truncate">{option.label}</span>
                              </>
                            );
                          }}
                          renderOption={(option) => {
                            const project = projects.find((p) => p.id === option.id);
                            return (
                              <>
                                {project && (
                                  <span
                                    className="h-3.5 w-3.5 shrink-0 rounded-sm"
                                    style={{ backgroundColor: (project as any).color ?? "#6366f1" }}
                                  />
                                )}
                                <span className="truncate">{option.label}</span>
                              </>
                            );
                          }}
                        />
                      </div>

                      {/* Priority chip — popover picker like NewIssueDialog */}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <NodePriorityChip
                          value={node.defaultPriority ?? null}
                          items={priorityItems}
                          onChange={(val) => updateNode(i, { defaultPriority: val })}
                        />
                      </div>

                      {/* Reviewer */}
                      <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                        <span className="text-xs shrink-0">Reviewed by</span>
                        <InlineEntitySelector
                          value={(() => {
                            const vals = stageParticipantValues(node.executionPolicy, "review");
                            return vals[0]?.startsWith("agent:") ? vals[0].slice("agent:".length) : "";
                          })()}
                          options={assigneeOptions}
                          placeholder="Reviewer"
                          noneLabel="No reviewer"
                          searchPlaceholder="Search agents..."
                          emptyMessage="No agents found."
                          onChange={(val) =>
                            updateNode(i, {
                              executionPolicy: buildExecutionPolicy({
                                existingPolicy: node.executionPolicy ?? null,
                                reviewerValues: val ? [`agent:${val}`] : [],
                                approverValues: stageParticipantValues(node.executionPolicy, "approval"),
                              }) ?? undefined,
                            })
                          }
                          renderTriggerValue={(option) => {
                            if (!option) return <span className="text-muted-foreground">Reviewer</span>;
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

                      {/* Approver */}
                      <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                        <span className="text-xs shrink-0">Approved by</span>
                        <InlineEntitySelector
                          value={(() => {
                            const vals = stageParticipantValues(node.executionPolicy, "approval");
                            return vals[0]?.startsWith("agent:") ? vals[0].slice("agent:".length) : "";
                          })()}
                          options={assigneeOptions}
                          placeholder="Approver"
                          noneLabel="No approver"
                          searchPlaceholder="Search agents..."
                          emptyMessage="No agents found."
                          onChange={(val) =>
                            updateNode(i, {
                              executionPolicy: buildExecutionPolicy({
                                existingPolicy: node.executionPolicy ?? null,
                                reviewerValues: stageParticipantValues(node.executionPolicy, "review"),
                                approverValues: val ? [`agent:${val}`] : [],
                              }) ?? undefined,
                            })
                          }
                          renderTriggerValue={(option) => {
                            if (!option) return <span className="text-muted-foreground">Approver</span>;
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

                      {/* Execution policy */}
                      <div className="space-y-2">
                        <div className="text-xs text-muted-foreground font-medium">Execution policy</div>
                        <div className="flex items-end gap-4 flex-wrap">
                          <div className="flex flex-col gap-0.5">
                            <label className="text-xs text-muted-foreground">Mode</label>
                            <select
                              className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                              value={node.executionPolicy?.mode ?? "normal"}
                              onChange={(e) =>
                                updateNode(i, {
                                  executionPolicy: {
                                    mode: e.target.value as "normal" | "auto",
                                    commentRequired: node.executionPolicy?.commentRequired ?? true,
                                    stages: node.executionPolicy?.stages ?? [],
                                  },
                                })
                              }
                            >
                              <option value="normal">Normal</option>
                              <option value="auto">Auto</option>
                            </select>
                          </div>
                          <label className="flex items-center gap-1.5 pb-1.5 cursor-pointer">
                            <input
                              type="checkbox"
                              className="rounded border-border"
                              checked={node.executionPolicy?.commentRequired ?? true}
                              onChange={(e) =>
                                updateNode(i, {
                                  executionPolicy: {
                                    mode: node.executionPolicy?.mode ?? "normal",
                                    commentRequired: e.target.checked,
                                    stages: node.executionPolicy?.stages ?? [],
                                  },
                                })
                              }
                            />
                            <span className="text-xs text-muted-foreground">Require comment on decision</span>
                          </label>
                        </div>
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

// ── Priority chip (matches NewIssueDialog pattern) ──────────────────────

interface PriorityItem {
  value: IssuePriority;
  label: string;
  icon: typeof Minus;
  color: string;
}

function NodePriorityChip({
  value,
  items,
  onChange,
}: {
  value: IssuePriority | null;
  items: PriorityItem[];
  onChange: (v: IssuePriority | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = items.find((p) => p.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors"
        >
          {current ? (
            <>
              <current.icon className={cn("h-3 w-3", current.color)} />
              {current.label}
            </>
          ) : (
            <>
              <Minus className="h-3 w-3 text-muted-foreground" />
              Priority
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-36 p-1" align="start">
        <button
          type="button"
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            !value && "bg-accent",
          )}
          onClick={() => { onChange(null); setOpen(false); }}
        >
          <Minus className="h-3 w-3 text-muted-foreground" />
          Default
        </button>
        {items.map((p) => (
          <button
            key={p.value}
            type="button"
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              p.value === value && "bg-accent",
            )}
            onClick={() => { onChange(p.value); setOpen(false); }}
          >
            <p.icon className={cn("h-3 w-3", p.color)} />
            {p.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
