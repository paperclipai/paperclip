import { useState, useEffect, useMemo, useDeferredValue } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { blueprintsApi, type AgentBlueprint } from "../api/blueprints";
import { companySkillsApi } from "../api/companySkills";
import type { CompanySkillListItem } from "@paperclipai/shared";
import { queryKeys } from "../lib/queryKeys";
import { AGENT_ROLES, AGENT_ROLE_LABELS } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { agentUrl } from "../lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { AgentConfigForm, type CreateConfigValues } from "../components/AgentConfigForm";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { getUIAdapter } from "../adapters";
import { roleLabels, adapterLabels } from "../components/agent-config-primitives";
import { SkillsMultiSelect } from "../components/SkillsMultiSelect";
import { TagsInput } from "../components/TagsInput";
import { AgentIcon } from "../components/AgentIconPicker";
import {
  Search,
  Plus,
  Layers,
  Boxes,
  Download,
  Upload,
  Pencil,
  Trash2,
  ChevronDown,
  Shield,
  Tag,
  Zap,
  ExternalLink,
} from "lucide-react";
import { cn } from "../lib/utils";

type DialogMode = "create" | "edit" | "delete" | null;

interface BlueprintFormState {
  name: string;
  description: string;
  role: string;
  title: string;
  capabilities: string;
  tags: string[];
  adapterType: string;
  configValues: CreateConfigValues;
  budgetMonthlyCents: number;
  desiredSkills: string[];
  instructionsContent: string;
}

function emptyFormState(): BlueprintFormState {
  return {
    name: "",
    description: "",
    role: "general",
    title: "",
    capabilities: "",
    tags: [],
    adapterType: defaultCreateValues.adapterType,
    configValues: { ...defaultCreateValues },
    budgetMonthlyCents: 0,
    desiredSkills: [],
    instructionsContent: "",
  };
}

function blueprintToFormState(bp: AgentBlueprint): BlueprintFormState {
  const metaSkills = bp.metadata?.desiredSkills;
  return {
    name: bp.name,
    description: bp.description ?? "",
    role: bp.role,
    title: bp.title ?? "",
    capabilities: bp.capabilities ?? "",
    tags: bp.tags,
    adapterType: bp.adapterType,
    configValues: {
      ...defaultCreateValues,
      adapterType: bp.adapterType,
      ...(bp.adapterConfig as Partial<CreateConfigValues>),
    },
    budgetMonthlyCents: bp.budgetMonthlyCents,
    desiredSkills: Array.isArray(metaSkills) ? (metaSkills as string[]) : [],
    instructionsContent: bp.instructionsContent ?? "",
  };
}

const SKILLS_COLLAPSED_LIMIT = 3;

function BlueprintCard({
  blueprint,
  availableSkills,
  onEdit,
  onDelete,
  onUse,
  onExport,
}: {
  blueprint: AgentBlueprint;
  availableSkills: CompanySkillListItem[];
  onEdit: () => void;
  onDelete: () => void;
  onUse: () => void;
  onExport: () => void;
}) {
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  const desiredSkillKeys = useMemo(() => {
    const raw = blueprint.metadata?.desiredSkills;
    return Array.isArray(raw) ? (raw as string[]) : [];
  }, [blueprint.metadata]);

  const skillNames = useMemo(
    () =>
      desiredSkillKeys.map((key) => {
        const match = availableSkills.find((s) => s.key === key);
        if (match) return match.name;
        const segment = key.split("/").pop() ?? key;
        return segment.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      }),
    [desiredSkillKeys, availableSkills],
  );

  const visibleSkills = skillsExpanded ? skillNames : skillNames.slice(0, SKILLS_COLLAPSED_LIMIT);
  const hiddenCount = skillNames.length - SKILLS_COLLAPSED_LIMIT;

  const summary = blueprint.description || blueprint.capabilities;

  return (
    <div className="border border-border bg-card rounded-lg flex flex-col hover:bg-accent/30 transition-colors">

      {/* ── Header ── */}
      <div className="flex items-start gap-2.5 px-3 pt-3 pb-2">
        <div className="mt-0.5 rounded-md border border-border bg-muted/40 p-1.5 shrink-0">
          {blueprint.icon
            ? <AgentIcon icon={blueprint.icon} className="size-3.5 text-muted-foreground" />
            : <Layers className="size-3.5 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1.5">
            <span className="font-medium text-sm text-foreground leading-snug">{blueprint.name}</span>
            <div className="flex items-center gap-1 shrink-0">
              {blueprint.sourceAgentId && (
                <span className="rounded-full bg-muted border border-border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Derived
                </span>
              )}
              <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {AGENT_ROLE_LABELS[blueprint.role as keyof typeof AGENT_ROLE_LABELS] ?? blueprint.role}
              </span>
            </div>
          </div>
          {blueprint.title && (
            <p className="text-xs text-muted-foreground mt-0.5 truncate">{blueprint.title}</p>
          )}
        </div>
      </div>

      {/* ── Description / capabilities ── */}
      {summary && (
        <div className="px-3 pb-2">
          <p className={`text-xs text-muted-foreground ${summaryExpanded ? "" : "line-clamp-2"}`}>
            {summary}
          </p>
          <button
            type="button"
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors mt-0.5"
            onClick={(e) => { e.stopPropagation(); setSummaryExpanded((v) => !v); }}
          >
            {summaryExpanded ? "less" : "more"}
          </button>
        </div>
      )}

      {/* ── Chips: adapter + tags + skills ── */}
      <div className="px-3 pb-3 space-y-1.5 flex-1">
        {/* Adapter + user tags */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {adapterLabels[blueprint.adapterType] ?? blueprint.adapterType}
          </span>
          {blueprint.tags.slice(0, 4).map((tag) => (
            <span key={tag} className="rounded bg-accent/60 px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {tag}
            </span>
          ))}
          {blueprint.tags.length > 4 && (
            <span className="text-[10px] text-muted-foreground">+{blueprint.tags.length - 4}</span>
          )}
        </div>

        {/* Skills row — always chips, expand inline */}
        {skillNames.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            <Boxes className="size-3 text-muted-foreground/60 shrink-0" />
            {visibleSkills.map((name, i) => (
              <span
                key={desiredSkillKeys[i]}
                className="rounded bg-primary/10 border border-primary/20 px-1.5 py-0.5 text-[10px] text-primary/80"
              >
                {name}
              </span>
            ))}
            {!skillsExpanded && hiddenCount > 0 && (
              <button
                type="button"
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => { e.stopPropagation(); setSkillsExpanded(true); }}
              >
                +{hiddenCount} more
              </button>
            )}
            {skillsExpanded && skillNames.length > SKILLS_COLLAPSED_LIMIT && (
              <button
                type="button"
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                onClick={(e) => { e.stopPropagation(); setSkillsExpanded(false); }}
              >
                less
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Actions ── */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-t border-border/60 mt-auto">
        <Button size="sm" className="h-6 text-xs px-2" onClick={onUse}>
          <Zap className="size-3 mr-1" />
          Use
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" className="h-6 w-6" onClick={onExport} title="Export">
            <Download className="size-3" />
          </Button>
          <Button size="icon-sm" variant="ghost" className="h-6 w-6" onClick={onEdit} title="Edit">
            <Pencil className="size-3" />
          </Button>
          <Button size="icon-sm" variant="ghost" className="h-6 w-6 text-destructive hover:bg-destructive/10" onClick={onDelete} title="Delete">
            <Trash2 className="size-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}


function BlueprintFormDialog({
  open,
  mode,
  initial,
  onClose,
  onSave,
  saving,
  error,
  availableSkills,
  hasCompany,
}: {
  open: boolean;
  mode: "create" | "edit";
  initial: BlueprintFormState;
  onClose: () => void;
  onSave: (state: BlueprintFormState) => void;
  saving: boolean;
  error: string | null;
  availableSkills: CompanySkillListItem[];
  hasCompany: boolean;
}) {
  const [form, setForm] = useState<BlueprintFormState>(initial);
  const [roleOpen, setRoleOpen] = useState(false);

  useEffect(() => {
    if (open) setForm(initial);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function patch(partial: Partial<BlueprintFormState>) {
    setForm((prev) => ({ ...prev, ...partial }));
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === "create" ? "New Blueprint" : "Edit Blueprint"}</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? "Create a reusable agent configuration template."
              : "Update this blueprint's configuration."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          {/* Name */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Name *</label>
            <Input
              value={form.name}
              onChange={(e) => patch({ name: e.target.value })}
              placeholder="e.g. Senior Frontend Engineer"
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Description</label>
            <Input
              value={form.description}
              onChange={(e) => patch({ description: e.target.value })}
              placeholder="Short summary of when to use this blueprint"
            />
          </div>

          {/* Role + Title row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Role</label>
              <Popover open={roleOpen} onOpenChange={setRoleOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent/50 transition-colors"
                  >
                    <span className="flex items-center gap-2">
                      <Shield className="size-3.5 text-muted-foreground" />
                      {roleLabels[form.role] ?? form.role}
                    </span>
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-40 p-1" align="start">
                  {AGENT_ROLES.map((r) => (
                    <button
                      key={r}
                      type="button"
                      className={cn(
                        "flex w-full items-center px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                        r === form.role && "bg-accent"
                      )}
                      onClick={() => { patch({ role: r }); setRoleOpen(false); }}
                    >
                      {roleLabels[r] ?? r}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</label>
              <Input
                value={form.title}
                onChange={(e) => patch({ title: e.target.value })}
                placeholder="e.g. VP of Engineering"
              />
            </div>
          </div>

          {/* Capabilities */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Capabilities</label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-none"
              rows={2}
              value={form.capabilities}
              onChange={(e) => patch({ capabilities: e.target.value })}
              placeholder="Brief description of what this agent can do"
            />
          </div>

          {/* Instructions */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Instructions</label>
            <textarea
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring resize-y"
              rows={6}
              value={form.instructionsContent}
              onChange={(e) => patch({ instructionsContent: e.target.value })}
              placeholder="Agent instructions (AGENTS.md content). Passed to the agent on every run."
            />
          </div>

          {/* Tags */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Tags</label>
            <div className="rounded-md border border-input bg-background px-3 py-1.5">
              <TagsInput value={form.tags} onChange={(tags) => patch({ tags })} />
            </div>
          </div>

          {/* Adapter config */}
          <div className="border border-border rounded-md overflow-hidden">
            <div className="px-3 py-2 bg-muted/30 border-b border-border">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Adapter Configuration</p>
            </div>
            <AgentConfigForm
              mode="create"
              values={form.configValues}
              onChange={(patch) => setForm((prev) => ({ ...prev, configValues: { ...prev.configValues, ...patch } }))}
            />
          </div>

          {/* Desired Skills */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Desired Skills</label>
            {availableSkills.length === 0 ? (
              <p className="text-xs text-muted-foreground rounded-md border border-dashed border-border px-3 py-2">
                {!hasCompany
                  ? "Select a company in the sidebar to load its optional skills here."
                  : "No optional skills installed in this company yet. Import skills via the company Skills page to make them selectable here."}
              </p>
            ) : (
              <SkillsMultiSelect
                skills={availableSkills}
                selected={form.desiredSkills}
                onChange={(keys) => patch({ desiredSkills: keys })}
              />
            )}
          </div>

          {/* Budget */}
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Monthly Budget (cents)</label>
            <Input
              type="number"
              min={0}
              value={form.budgetMonthlyCents}
              onChange={(e) => patch({ budgetMonthlyCents: parseInt(e.target.value, 10) || 0 })}
              placeholder="0 = no limit"
            />
          </div>
        </div>

        {error && <p className="text-xs text-destructive mt-1">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => onSave(form)} disabled={!form.name.trim() || saving}>
            {saving ? "Saving…" : mode === "create" ? "Create Blueprint" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Blueprints() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const [roleFilter, setRoleFilter] = useState("");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [dialogMode, setDialogMode] = useState<DialogMode>(null);
  const [activeBlueprint, setActiveBlueprint] = useState<AgentBlueprint | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Blueprints" }]);
  }, [setBreadcrumbs]);

  const blueprintsQ = useQuery({
    queryKey: queryKeys.blueprints.list(deferredSearch || undefined, roleFilter || undefined),
    queryFn: () => blueprintsApi.list({ search: deferredSearch || undefined, role: roleFilter || undefined }),
  });

  const { data: companySkills } = useQuery({
    queryKey: queryKeys.companySkills.list(selectedCompanyId ?? ""),
    queryFn: () => companySkillsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const availableSkills = (companySkills ?? []).filter(
    (s) => !s.key.startsWith("paperclipai/paperclip/"),
  );

  const createMutation = useMutation({
    mutationFn: (input: Parameters<typeof blueprintsApi.create>[0]) => blueprintsApi.create(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.blueprints.all });
      setDialogMode(null);
      setFormError(null);
      pushToast({ tone: "success", title: "Blueprint created" });
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : "Failed to create blueprint"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: Parameters<typeof blueprintsApi.update>[1] }) =>
      blueprintsApi.update(id, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.blueprints.all });
      setDialogMode(null);
      setFormError(null);
      pushToast({ tone: "success", title: "Blueprint saved" });
    },
    onError: (e) => setFormError(e instanceof Error ? e.message : "Failed to update blueprint"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => blueprintsApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.blueprints.all });
      setDialogMode(null);
      pushToast({ tone: "success", title: "Blueprint deleted" });
    },
  });

  function handleSave(state: BlueprintFormState) {
    setFormError(null);
    const adapter = getUIAdapter(state.configValues.adapterType);
    const adapterConfig = adapter.buildAdapterConfig(state.configValues);

    const basePayload = {
      name: state.name.trim(),
      description: state.description.trim() || null,
      role: state.role as typeof AGENT_ROLES[number],
      title: state.title.trim() || null,
      capabilities: state.capabilities.trim() || null,
      tags: state.tags,
      adapterType: state.configValues.adapterType,
      adapterConfig,
      budgetMonthlyCents: state.budgetMonthlyCents,
      metadata: state.desiredSkills.length > 0 ? { desiredSkills: state.desiredSkills } : null,
      instructionsContent: state.instructionsContent.trim() || null,
    };

    if (dialogMode === "create") {
      createMutation.mutate({ ...basePayload, runtimeConfig: {}, permissions: {} });
    } else if (dialogMode === "edit" && activeBlueprint) {
      updateMutation.mutate({ id: activeBlueprint.id, input: basePayload });
    }
  }

  function handleExport(bp: AgentBlueprint) {
    const json = JSON.stringify(bp, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bp.name.toLowerCase().replace(/\s+/g, "-")}.blueprint.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    setImportError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const raw = JSON.parse(ev.target?.result as string) as Partial<AgentBlueprint>;
        if (!raw.name) throw new Error("Missing required field: name");
        const { id: _id, createdAt: _c, updatedAt: _u, ...payload } = raw as AgentBlueprint;
        await blueprintsApi.create({
          name: payload.name,
          description: payload.description ?? null,
          role: payload.role ?? "general",
          title: payload.title ?? null,
          capabilities: payload.capabilities ?? null,
          tags: payload.tags ?? [],
          adapterType: payload.adapterType ?? "process",
          adapterConfig: payload.adapterConfig ?? {},
          runtimeConfig: payload.runtimeConfig ?? {},
          budgetMonthlyCents: payload.budgetMonthlyCents ?? 0,
          permissions: payload.permissions ?? {},
          instructionsContent: payload.instructionsContent ?? null,
          metadata: payload.metadata ?? null,
          sourceAgentId: payload.sourceAgentId ?? null,
          sourceBlueprintId: payload.sourceBlueprintId ?? null,
        });
        queryClient.invalidateQueries({ queryKey: queryKeys.blueprints.all });
        pushToast({ tone: "success", title: "Blueprint imported" });
      } catch (err) {
        setImportError(err instanceof Error ? err.message : "Invalid blueprint file");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function handleUse(bp: AgentBlueprint) {
    const prefix = selectedCompany?.issuePrefix?.toUpperCase();
    if (prefix) {
      navigate(`/${prefix}/agents/new?blueprintId=${bp.id}`);
    } else {
      pushToast({ tone: "warn", title: "Select a company first to hire from a blueprint." });
    }
  }

  const allBlueprints = blueprintsQ.data ?? [];
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const bp of allBlueprints) for (const t of bp.tags) set.add(t);
    return [...set].sort();
  }, [allBlueprints]);
  const blueprints = activeTag ? allBlueprints.filter((bp) => bp.tags.includes(activeTag)) : allBlueprints;
  const isSaving = createMutation.isPending || updateMutation.isPending;

  const formInitial = dialogMode === "edit" && activeBlueprint
    ? blueprintToFormState(activeBlueprint)
    : emptyFormState();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Layers className="size-5 text-muted-foreground" />
            Blueprints
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Instance-wide agent configuration templates. Use them to quickly hire agents across any company.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <label
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-accent/50"
          >
            <input type="file" accept=".json" className="hidden" onChange={handleImport} />
            <Upload className="size-3.5" />
            Import
          </label>
          <Button
            size="sm"
            onClick={() => { setActiveBlueprint(null); setFormError(null); setDialogMode("create"); }}
          >
            <Plus className="size-3.5 mr-1.5" />
            New Blueprint
          </Button>
        </div>
      </div>

      {importError && (
        <p className="text-sm text-destructive border border-destructive/30 rounded-md px-3 py-2 bg-destructive/5">
          Import failed: {importError}
        </p>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search blueprints…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
        >
          <option value="">All roles</option>
          {AGENT_ROLES.map((r) => (
            <option key={r} value={r}>{AGENT_ROLE_LABELS[r]}</option>
          ))}
        </select>
      </div>

      {/* Tag filter chips */}
      {allTags.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap -mt-2">
          <Tag className="size-3 text-muted-foreground shrink-0" />
          {allTags.map((tag) => (
            <button
              key={tag}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
              className={cn(
                "rounded px-2 py-0.5 text-[11px] border transition-colors",
                activeTag === tag
                  ? "border-foreground/40 bg-foreground/10 text-foreground"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground"
              )}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* No company warning */}
      {!selectedCompanyId && (
        <div className="rounded-md border border-border bg-muted/30 px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
          <ExternalLink className="size-3.5 shrink-0" />
          Select a company first to use blueprints for hiring agents.
        </div>
      )}

      {/* List */}
      {blueprintsQ.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading blueprints…</p>
      ) : blueprints.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Layers className="size-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">No blueprints yet</p>
          <p className="text-xs mt-1">Create a blueprint to reuse agent configurations across companies.</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-4"
            onClick={() => { setActiveBlueprint(null); setFormError(null); setDialogMode("create"); }}
          >
            <Plus className="size-3.5 mr-1.5" />
            Create first blueprint
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {blueprints.map((bp) => (
            <BlueprintCard
              key={bp.id}
              blueprint={bp}
              availableSkills={availableSkills}
              onEdit={() => { setActiveBlueprint(bp); setFormError(null); setDialogMode("edit"); }}
              onDelete={() => { setActiveBlueprint(bp); setDialogMode("delete"); }}
              onUse={() => handleUse(bp)}
              onExport={() => handleExport(bp)}
            />
          ))}
        </div>
      )}

      {/* Create / Edit dialog */}
      {(dialogMode === "create" || dialogMode === "edit") && (
        <BlueprintFormDialog
          open
          mode={dialogMode}
          initial={formInitial}
          onClose={() => { setDialogMode(null); setFormError(null); }}
          onSave={handleSave}
          saving={isSaving}
          error={formError}
          availableSkills={availableSkills}
          hasCompany={Boolean(selectedCompanyId)}
        />
      )}

      {/* Delete confirmation */}
      <Dialog open={dialogMode === "delete"} onOpenChange={(v) => !v && setDialogMode(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Blueprint</DialogTitle>
            <DialogDescription>
              Delete <strong>{activeBlueprint?.name}</strong>? This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogMode(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => activeBlueprint && deleteMutation.mutate(activeBlueprint.id)}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
