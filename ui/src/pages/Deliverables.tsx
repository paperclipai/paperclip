import { useEffect, useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { deliverablesApi, type Deliverable, type CreateDeliverableInput } from "../api/deliverables";
import { reviewTemplatesApi, type ReviewPipelineTemplate } from "../api/reviewTemplates";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { DeliverableCard } from "../components/DeliverableCard";
import { DeliverableStatusBadge } from "../components/DeliverableStatusBadge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  PackageCheck,
  Plus,
  Filter,
  ClipboardCheck,
  ListTodo,
  LayoutTemplate,
  Trash2,
  Pencil,
  GripVertical,
  X,
} from "lucide-react";

// ─── Stage type used in the editor ────────────────────────────────────
interface TemplateStage {
  label: string;
  reviewerAgentId?: string;
  reviewerUserId?: string;
  role?: string;
}

const TEMPLATE_PRESETS: { name: string; description: string; stages: TemplateStage[] }[] = [
  {
    name: "Quick Approval",
    description: "Single-stage manager sign-off for low-risk changes",
    stages: [{ label: "Manager Approval" }],
  },
  {
    name: "Code Review Pipeline",
    description: "Standard software development review process",
    stages: [
      { label: "Technical Review" },
      { label: "Code Review" },
      { label: "QA Verification" },
    ],
  },
  {
    name: "Document Review",
    description: "Content and editorial review for documents and reports",
    stages: [
      { label: "Content Review" },
      { label: "Editorial Review" },
      { label: "Final Approval" },
    ],
  },
  {
    name: "Deployment Pipeline",
    description: "Multi-gate deployment approval for production releases",
    stages: [
      { label: "Technical Validation" },
      { label: "Security Review" },
      { label: "Staging Verification" },
      { label: "Deployment Approval" },
    ],
  },
  {
    name: "Design Review",
    description: "UX and design review pipeline for visual deliverables",
    stages: [
      { label: "Design Review" },
      { label: "Accessibility Check" },
      { label: "Stakeholder Approval" },
    ],
  },
  {
    name: "Full Governance Review",
    description: "Comprehensive multi-department review for critical deliverables",
    stages: [
      { label: "Technical Review" },
      { label: "Design Review" },
      { label: "Security Audit" },
      { label: "QA Verification" },
      { label: "Board Approval" },
    ],
  },
];

type Tab = "review-queue" | "all" | "templates";
const STATUS_FILTERS = ["all", "draft", "in_review", "changes_requested", "approved", "rejected", "reopened"] as const;

export function Deliverables() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("review-queue");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [templateStages, setTemplateStages] = useState<TemplateStage[]>([]);
  const [newStageName, setNewStageName] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Deliverables" }]);
  }, [setBreadcrumbs]);

  // ── Data fetching ────────────────────────────────────────────────
  const { data: deliverables, isLoading: loadingDeliverables, error: deliverableError } = useQuery({
    queryKey: queryKeys.deliverables.list(selectedCompanyId!),
    queryFn: () => deliverablesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: templates, isLoading: loadingTemplates } = useQuery({
    queryKey: queryKeys.reviewTemplates.list(selectedCompanyId!),
    queryFn: () => reviewTemplatesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeTab === "templates",
  });

  // ── Mutations ────────────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: (data: CreateDeliverableInput) =>
      deliverablesApi.create(selectedCompanyId!, data),
    onSuccess: (d) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.deliverables.list(selectedCompanyId!) });
      setShowCreateForm(false);
      pushToast({ title: "Deliverable created", body: d.title, tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to create deliverable", body: err.message, tone: "error" });
    },
  });

  const createTemplateMutation = useMutation({
    mutationFn: (data: { name: string; description?: string; stages: unknown[]; isDefault?: boolean }) =>
      reviewTemplatesApi.create(selectedCompanyId!, data),
    onSuccess: (t) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewTemplates.list(selectedCompanyId!) });
      setShowTemplateForm(false);
      pushToast({ title: "Template created", body: t.name, tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to create template", body: err.message, tone: "error" });
    },
  });

  const seedTemplatesMutation = useMutation({
    mutationFn: () => reviewTemplatesApi.seed(selectedCompanyId!),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewTemplates.list(selectedCompanyId!) });
      pushToast({ title: `${result.seeded} default templates loaded`, tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to load templates", body: err.message, tone: "error" });
    },
  });

  const deleteTemplateMutation = useMutation({
    mutationFn: (id: string) => reviewTemplatesApi.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewTemplates.list(selectedCompanyId!) });
      pushToast({ title: "Template deleted", tone: "info" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to delete template", body: err.message, tone: "error" });
    },
  });

  const updateTemplateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      reviewTemplatesApi.update(id, data),
    onSuccess: (t) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.reviewTemplates.list(selectedCompanyId!) });
      pushToast({ title: "Template updated", body: t.name, tone: "success" });
    },
    onError: (err) => {
      pushToast({ title: "Failed to update template", body: err.message, tone: "error" });
    },
  });

  // ── Derived data ─────────────────────────────────────────────────
  const reviewQueue = useMemo(
    () => (deliverables ?? []).filter((d) => d.status === "in_review" || d.status === "changes_requested"),
    [deliverables],
  );

  const filteredDeliverables = useMemo(() => {
    if (!deliverables) return [];
    if (statusFilter === "all") return deliverables;
    return deliverables.filter((d) => d.status === statusFilter);
  }, [deliverables, statusFilter]);

  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const d of deliverables ?? []) {
      counts[d.status] = (counts[d.status] ?? 0) + 1;
    }
    return counts;
  }, [deliverables]);

  // ── Handlers ─────────────────────────────────────────────────────
  function handleCreateDeliverable(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createMutation.mutate({
      title: fd.get("title") as string,
      description: (fd.get("description") as string) || undefined,
      type: (fd.get("type") as string) || "mixed",
      priority: (fd.get("priority") as string) || "medium",
    });
  }

  function handleCreateTemplate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    createTemplateMutation.mutate(
      {
        name: fd.get("name") as string,
        description: (fd.get("description") as string) || undefined,
        stages: templateStages,
        isDefault: fd.get("isDefault") === "on",
      },
      {
        onSuccess: () => {
          setTemplateStages([]);
          setNewStageName("");
        },
      },
    );
  }

  function addTemplateStage() {
    const label = newStageName.trim();
    if (!label) return;
    setTemplateStages((prev) => [...prev, { label }]);
    setNewStageName("");
  }

  function removeTemplateStage(index: number) {
    setTemplateStages((prev) => prev.filter((_, i) => i !== index));
  }

  function moveTemplateStage(index: number, direction: -1 | 1) {
    setTemplateStages((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  // ── Guards ───────────────────────────────────────────────────────
  if (!selectedCompanyId) {
    return <EmptyState icon={PackageCheck} message="Select a company to view deliverables." />;
  }

  if (loadingDeliverables) {
    return <PageSkeleton variant="list" />;
  }

  // ── Tab headers ──────────────────────────────────────────────────
  const tabs: { id: Tab; label: string; icon: typeof ClipboardCheck; count?: number }[] = [
    { id: "review-queue", label: "Review Queue", icon: ClipboardCheck, count: reviewQueue.length },
    { id: "all", label: "All Deliverables", icon: ListTodo, count: deliverables?.length },
    { id: "templates", label: "Templates", icon: LayoutTemplate, count: templates?.length },
  ];

  return (
    <div className="space-y-4">
      {deliverableError && (
        <p className="text-sm text-destructive">{deliverableError.message}</p>
      )}

      {/* Tab bar */}
      <div className="flex items-center justify-between gap-2 border-b border-border pb-2">
        <div className="flex gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`inline-flex items-center gap-1.5 rounded-[2px] px-3 py-1.5 text-xs font-medium font-[var(--font-mono)] uppercase tracking-[0.06em] transition-colors ${
                activeTab === tab.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-[var(--sidebar-accent)]"
              }`}
            >
              <tab.icon className="h-3.5 w-3.5" />
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <Badge variant="secondary" className="ml-1 rounded-[2px] font-[var(--font-mono)] text-[9px] uppercase px-1.5 py-0">
                  {tab.count}
                </Badge>
              )}
            </button>
          ))}
        </div>
        {activeTab !== "templates" && (
          <Button size="sm" variant="outline" onClick={() => setShowCreateForm((v) => !v)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Deliverable
          </Button>
        )}
        {activeTab === "templates" && (
          <Button size="sm" variant="outline" onClick={() => setShowTemplateForm((v) => !v)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Template
          </Button>
        )}
      </div>

      {/* Create deliverable form */}
      {showCreateForm && activeTab !== "templates" && (
        <form onSubmit={handleCreateDeliverable} className="rounded-[2px] border border-border bg-card p-4 space-y-3 hud-panel hud-shimmer">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Title *</label>
              <input
                name="title"
                required
                className="mt-1 w-full rounded-[2px] border border-input bg-secondary px-3 py-1.5 text-sm"
                placeholder="Deliverable title"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <select
                name="type"
                className="mt-1 w-full rounded-[2px] border border-input bg-secondary px-3 py-1.5 text-sm"
              >
                <option value="mixed">Mixed</option>
                <option value="code">Code</option>
                <option value="document">Document</option>
                <option value="deployment">Deployment</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Priority</label>
              <select
                name="priority"
                className="mt-1 w-full rounded-[2px] border border-input bg-secondary px-3 py-1.5 text-sm"
              >
                <option value="medium">Medium</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <input
                name="description"
                className="mt-1 w-full rounded-[2px] border border-input bg-secondary px-3 py-1.5 text-sm"
                placeholder="Optional description"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={createMutation.isPending}>
              {createMutation.isPending ? "Creating..." : "Create"}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setShowCreateForm(false)}>
              Cancel
            </Button>
          </div>
          {createMutation.error && (
            <p className="text-xs text-destructive">{createMutation.error.message}</p>
          )}
        </form>
      )}

      {/* ── Review Queue Tab ─────────────────────────────────────────── */}
      {activeTab === "review-queue" && (
        <>
          {reviewQueue.length === 0 ? (
            <EmptyState
              icon={ClipboardCheck}
              message="No deliverables awaiting review."
              action="New Deliverable"
              onAction={() => setShowCreateForm(true)}
            />
          ) : (
            <div className="space-y-2">
              {reviewQueue.map((d) => (
                <DeliverableCard key={d.id} deliverable={d} />
              ))}
            </div>
          )}
        </>
      )}

      {/* ── All Deliverables Tab ─────────────────────────────────────── */}
      {activeTab === "all" && (
        <>
          {deliverables && deliverables.length === 0 && !showCreateForm ? (
            <EmptyState
              icon={PackageCheck}
              message="No deliverables yet."
              action="New Deliverable"
              onAction={() => setShowCreateForm(true)}
            />
          ) : (
            <>
              {/* Status filter chips */}
              <div className="flex items-center gap-2">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <div className="flex gap-1 flex-wrap">
                  {STATUS_FILTERS.map((s) => {
                    const count = s === "all" ? deliverables?.length ?? 0 : statusCounts[s] ?? 0;
                    return (
                      <Button
                        key={s}
                        size="sm"
                        variant={statusFilter === s ? "default" : "outline"}
                        className="text-xs capitalize"
                        onClick={() => setStatusFilter(s)}
                      >
                        {s.replace(/_/g, " ")}
                        {count > 0 && (
                          <span className="ml-1 text-[10px] opacity-70">({count})</span>
                        )}
                      </Button>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                {filteredDeliverables.map((d) => (
                  <DeliverableCard key={d.id} deliverable={d} />
                ))}
                {filteredDeliverables.length === 0 && deliverables && deliverables.length > 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    No deliverables match the selected filter.
                  </p>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* ── Templates Tab ────────────────────────────────────────────── */}
      {activeTab === "templates" && (
        <>
          {/* Create template form */}
          {showTemplateForm && (
            <form onSubmit={handleCreateTemplate} className="rounded-[2px] border border-border bg-card p-4 space-y-3 hud-panel hud-shimmer">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Template Name *</label>
                  <input
                    name="name"
                    required
                    className="mt-1 w-full rounded-[2px] border border-input bg-secondary px-3 py-1.5 text-sm"
                    placeholder="e.g. Standard Review"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Description</label>
                  <input
                    name="description"
                    className="mt-1 w-full rounded-[2px] border border-input bg-secondary px-3 py-1.5 text-sm"
                    placeholder="Optional description"
                  />
                </div>
              </div>

              {/* ── Preset Selector ─────────────────────────────── */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Start from a preset</label>
                <div className="flex flex-wrap gap-2">
                  {TEMPLATE_PRESETS.map((preset) => (
                    <button
                      key={preset.name}
                      type="button"
                      className="rounded-[2px] border border-border bg-background px-2.5 py-1.5 text-left hover:bg-[var(--sidebar-accent)] transition-colors"
                      onClick={() => {
                        setTemplateStages(preset.stages);
                        // Also set the name field if it's empty
                        const nameInput = document.querySelector<HTMLInputElement>('input[name="name"]');
                        if (nameInput && !nameInput.value) nameInput.value = preset.name;
                        const descInput = document.querySelector<HTMLInputElement>('input[name="description"]');
                        if (descInput && !descInput.value) descInput.value = preset.description;
                      }}
                      title={preset.description}
                    >
                      <div className="text-xs font-medium">{preset.name}</div>
                      <div className="text-[10px] text-muted-foreground">{preset.stages.length} stages</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* ── Stage Editor ──────────────────────────────────── */}
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Pipeline Stages</label>
                {templateStages.length > 0 && (
                  <div className="space-y-1">
                    {templateStages.map((stage, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 rounded-[2px] border border-border bg-background px-2 py-1.5 text-sm"
                      >
                        <GripVertical className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                        <span className="text-xs text-muted-foreground w-5 text-center shrink-0">{i + 1}</span>
                        <span className="flex-1 truncate text-sm">{stage.label}</span>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                            disabled={i === 0}
                            onClick={() => moveTemplateStage(i, -1)}
                            title="Move up"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                            disabled={i === templateStages.length - 1}
                            onClick={() => moveTemplateStage(i, 1)}
                            title="Move down"
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            className="p-0.5 text-muted-foreground hover:text-destructive"
                            onClick={() => removeTemplateStage(i)}
                            title="Remove stage"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <input
                    value={newStageName}
                    onChange={(e) => setNewStageName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTemplateStage();
                      }
                    }}
                    className="flex-1 rounded-[2px] border border-input bg-secondary px-3 py-1.5 text-sm"
                    placeholder="Stage name (e.g. Technical Review)"
                  />
                  <Button type="button" size="sm" variant="outline" onClick={addTemplateStage} disabled={!newStageName.trim()}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add
                  </Button>
                </div>
                {templateStages.length === 0 && (
                  <p className="text-[10px] text-muted-foreground italic">
                    No stages added — deliverables will auto-approve on submit. Add at least one stage for a review pipeline.
                  </p>
                )}
              </div>

              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" name="isDefault" className="rounded border-input" />
                <span className="text-muted-foreground">Set as company default template</span>
              </label>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={createTemplateMutation.isPending}>
                  {createTemplateMutation.isPending ? "Creating..." : "Create Template"}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => { setShowTemplateForm(false); setTemplateStages([]); setNewStageName(""); }}>
                  Cancel
                </Button>
              </div>
              {createTemplateMutation.error && (
                <p className="text-xs text-destructive">{createTemplateMutation.error.message}</p>
              )}
            </form>
          )}

          {loadingTemplates ? (
            <PageSkeleton variant="list" />
          ) : !templates || templates.length === 0 ? (
            <div className="flex flex-col items-center gap-4 py-12">
              <LayoutTemplate className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">No review pipeline templates yet.</p>
              <p className="text-xs text-muted-foreground max-w-md text-center">
                Templates define the review stages each deliverable goes through before approval.
                Load default templates to get started quickly, or create your own.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => seedTemplatesMutation.mutate()}
                  disabled={seedTemplatesMutation.isPending}
                >
                  {seedTemplatesMutation.isPending ? "Loading..." : "Load Default Templates"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowTemplateForm(true)}>
                  Create Custom Template
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map((t) => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  isSaving={updateTemplateMutation.isPending}
                  onUpdateStages={(stages) =>
                    updateTemplateMutation.mutate({ id: t.id, data: { stages } })
                  }
                  onDelete={() => {
                    if (confirm(`Delete template "${t.name}"?`)) {
                      deleteTemplateMutation.mutate(t.id);
                    }
                  }}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Template card sub-component ───────────────────────────────────
function TemplateCard({
  template,
  onDelete,
  onUpdateStages,
  isSaving,
}: {
  template: ReviewPipelineTemplate;
  onDelete: () => void;
  onUpdateStages: (stages: TemplateStage[]) => void;
  isSaving: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [stages, setStages] = useState<TemplateStage[]>(template.stages);
  const [newStage, setNewStage] = useState("");

  function addStage() {
    const label = newStage.trim();
    if (!label) return;
    setStages((prev) => [...prev, { label }]);
    setNewStage("");
  }

  function removeStage(idx: number) {
    setStages((prev) => prev.filter((_, i) => i !== idx));
  }

  function moveStage(idx: number, dir: -1 | 1) {
    setStages((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function handleSave() {
    onUpdateStages(stages);
    setEditing(false);
  }

  function handleCancel() {
    setStages(template.stages);
    setNewStage("");
    setEditing(false);
  }

  return (
    <div className="rounded-[2px] border border-border bg-card p-4 hud-panel hud-shimmer">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <LayoutTemplate className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">{template.name}</h3>
            {template.isDefault && (
              <Badge variant="outline" className="rounded-[2px] font-[var(--font-mono)] text-[9px] uppercase bg-[var(--status-info)]/10 text-[var(--status-info)] border-[var(--status-info)]/30">
                Default
              </Badge>
            )}
          </div>
          {template.description && (
            <p className="mt-1 text-xs text-muted-foreground">{template.description}</p>
          )}

          {/* View mode: show stage badges */}
          {!editing && template.stages.length > 0 && (
            <div className="mt-2 flex items-center gap-1 flex-wrap">
              {template.stages.map((stage, i) => (
                <span key={i} className="inline-flex items-center gap-1">
                  {i > 0 && <span className="text-muted-foreground/40">→</span>}
                  <Badge variant="secondary" className="rounded-[2px] font-[var(--font-mono)] text-[9px] uppercase">
                    {stage.label}
                  </Badge>
                </span>
              ))}
            </div>
          )}
          {!editing && template.stages.length === 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground italic">
              No stages defined — deliverables using this template will auto-approve on submit
            </p>
          )}

          {/* Edit mode: inline stage editor */}
          {editing && (
            <div className="mt-3 space-y-2">
              {stages.length > 0 && (
                <div className="space-y-1">
                  {stages.map((stage, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2 rounded-[2px] border border-border bg-background px-2 py-1.5 text-sm"
                    >
                      <GripVertical className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
                      <span className="text-xs text-muted-foreground w-5 text-center shrink-0">{i + 1}</span>
                      <span className="flex-1 truncate text-sm">{stage.label}</span>
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                          disabled={i === 0}
                          onClick={() => moveStage(i, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                          disabled={i === stages.length - 1}
                          onClick={() => moveStage(i, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="p-0.5 text-muted-foreground hover:text-destructive"
                          onClick={() => removeStage(i)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  value={newStage}
                  onChange={(e) => setNewStage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addStage();
                    }
                  }}
                  className="flex-1 rounded-[2px] border border-input bg-secondary px-3 py-1.5 text-sm"
                  placeholder="Stage name"
                />
                <Button type="button" size="sm" variant="outline" onClick={addStage} disabled={!newStage.trim()}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  Add
                </Button>
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save Stages"}
                </Button>
                <Button size="sm" variant="outline" onClick={handleCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!editing && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
              onClick={() => { setStages(template.stages); setEditing(true); }}
              title="Edit stages"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
