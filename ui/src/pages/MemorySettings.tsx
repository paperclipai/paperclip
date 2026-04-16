import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  Plus,
  Trash2,
  Pencil,
  Check,
  X,
  ChevronDown,
  ChevronRight,
  Activity,
} from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { memoryApi, type MemoryBinding, type MemoryBindingTarget } from "../api/memory";
import { agentsApi } from "../api/agents";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

// ── Create / Edit Dialog ──────────────────────────────────────────

function BindingDialog({
  open,
  onOpenChange,
  companyId,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  existing?: MemoryBinding | null;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [key, setKey] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [hooksPreRunEnabled, setHooksPreRunEnabled] = useState(true);
  const [hooksPreRunTopK, setHooksPreRunTopK] = useState(5);
  const [hooksPostRunEnabled, setHooksPostRunEnabled] = useState(true);
  const [hooksPostRunDepth, setHooksPostRunDepth] = useState<"summary" | "full">("summary");

  useEffect(() => {
    if (open) {
      if (existing) {
        setKey(existing.key);
        setProviderKey(existing.providerKey);
        setEnabled(existing.enabled);
        const hooks = (existing.config as { hooks?: Record<string, unknown> })?.hooks as {
          preRunHydrate?: { enabled?: boolean; topK?: number };
          postRunCapture?: { enabled?: boolean; captureDepth?: string };
        } | undefined;
        setHooksPreRunEnabled(hooks?.preRunHydrate?.enabled ?? true);
        setHooksPreRunTopK(hooks?.preRunHydrate?.topK ?? 5);
        setHooksPostRunEnabled(hooks?.postRunCapture?.enabled ?? true);
        setHooksPostRunDepth((hooks?.postRunCapture?.captureDepth as "summary" | "full") ?? "summary");
      } else {
        setKey("");
        setProviderKey("");
        setEnabled(true);
        setHooksPreRunEnabled(true);
        setHooksPreRunTopK(5);
        setHooksPostRunEnabled(true);
        setHooksPostRunDepth("summary");
      }
    }
  }, [open, existing]);

  const createMutation = useMutation({
    mutationFn: (data: Parameters<typeof memoryApi.createBinding>[1]) =>
      memoryApi.createBinding(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.memory.bindings(companyId) });
      pushToast({ title: "Binding created", tone: "success" });
      onOpenChange(false);
    },
    onError: (err) => pushToast({ title: (err as Error).message, tone: "error" }),
  });

  const updateMutation = useMutation({
    mutationFn: (data: Parameters<typeof memoryApi.updateBinding>[1]) =>
      memoryApi.updateBinding(existing!.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.memory.bindings(companyId) });
      pushToast({ title: "Binding updated", tone: "success" });
      onOpenChange(false);
    },
    onError: (err) => pushToast({ title: (err as Error).message, tone: "error" }),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const config = {
      hooks: {
        preRunHydrate: { enabled: hooksPreRunEnabled, topK: hooksPreRunTopK },
        postRunCapture: { enabled: hooksPostRunEnabled, captureDepth: hooksPostRunDepth },
      },
    };
    const payload = { key, providerKey, enabled, config };
    if (existing) {
      updateMutation.mutate(payload);
    } else {
      createMutation.mutate(payload);
    }
  }

  const saving = createMutation.isPending || updateMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? "Edit Binding" : "New Memory Binding"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Key</label>
            <input
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="e.g. default, long-term"
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Provider Key</label>
            <input
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              value={providerKey}
              onChange={(e) => setProviderKey(e.target.value)}
              placeholder="e.g. para"
              required
            />
          </div>
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">Enabled</label>
            <ToggleSwitch checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div className="border-t border-border pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
              Hook Configuration
            </p>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-sm">Pre-run hydration</span>
                <ToggleSwitch checked={hooksPreRunEnabled} onCheckedChange={setHooksPreRunEnabled} />
              </div>
              {hooksPreRunEnabled && (
                <div className="flex items-center gap-2 pl-4">
                  <label className="text-xs text-muted-foreground">Top K</label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    className="w-16 rounded-md border border-border bg-background px-2 py-1 text-sm"
                    value={hooksPreRunTopK}
                    onChange={(e) => setHooksPreRunTopK(parseInt(e.target.value) || 5)}
                  />
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-sm">Post-run capture</span>
                <ToggleSwitch checked={hooksPostRunEnabled} onCheckedChange={setHooksPostRunEnabled} />
              </div>
              {hooksPostRunEnabled && (
                <div className="flex items-center gap-2 pl-4">
                  <label className="text-xs text-muted-foreground">Depth</label>
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                    value={hooksPostRunDepth}
                    onChange={(e) => setHooksPostRunDepth(e.target.value as "summary" | "full")}
                  >
                    <option value="summary">Summary</option>
                    <option value="full">Full</option>
                  </select>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !key || !providerKey}>
              {saving ? "Saving..." : existing ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Binding Target Row ────────────────────────────────────────────

function TargetRow({
  target,
  agents,
  companyName,
  onRemove,
}: {
  target: MemoryBindingTarget;
  agents: { id: string; name: string }[];
  companyName: string;
  onRemove: () => void;
}) {
  const label =
    target.targetType === "company"
      ? `Company: ${companyName}`
      : `Agent: ${agents.find((a) => a.id === target.targetId)?.name ?? target.targetId.slice(0, 8)}`;

  return (
    <div className="flex items-center justify-between py-1.5 pl-4 text-sm">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-[10px]">
          {target.targetType}
        </Badge>
        <span>{label}</span>
        {target.priority !== 0 && (
          <span className="text-xs text-muted-foreground">priority {target.priority}</span>
        )}
      </div>
      <Button variant="ghost" size="icon-sm" onClick={onRemove}>
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

// ── Binding Card ──────────────────────────────────────────────────

function BindingCard({
  binding,
  companyId,
  companyName,
  agents,
  onEdit,
}: {
  binding: MemoryBinding;
  companyId: string;
  companyName: string;
  agents: { id: string; name: string }[];
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [expanded, setExpanded] = useState(false);
  const [addTargetType, setAddTargetType] = useState<"company" | "agent">("company");
  const [addTargetId, setAddTargetId] = useState("");
  const [showAddTarget, setShowAddTarget] = useState(false);

  const { data: targets } = useQuery({
    queryKey: queryKeys.memory.targets(binding.id),
    queryFn: () => memoryApi.listTargets(binding.id),
    enabled: expanded,
  });

  const deleteMutation = useMutation({
    mutationFn: () => memoryApi.deleteBinding(binding.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.memory.bindings(companyId) });
      pushToast({ title: "Binding deleted", tone: "success" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => memoryApi.updateBinding(binding.id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.memory.bindings(companyId) });
    },
  });

  const addTargetMutation = useMutation({
    mutationFn: (data: { targetType: "company" | "agent"; targetId: string }) =>
      memoryApi.addTarget(binding.id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.memory.targets(binding.id) });
      setShowAddTarget(false);
      setAddTargetId("");
      pushToast({ title: "Target added", tone: "success" });
    },
    onError: (err) => pushToast({ title: (err as Error).message, tone: "error" }),
  });

  const removeTargetMutation = useMutation({
    mutationFn: (targetId: string) => memoryApi.removeTarget(targetId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.memory.targets(binding.id) });
      pushToast({ title: "Target removed", tone: "success" });
    },
  });

  const hooks = (binding.config as { hooks?: Record<string, unknown> })?.hooks as {
    preRunHydrate?: { enabled?: boolean };
    postRunCapture?: { enabled?: boolean };
  } | undefined;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-sm">{binding.key}</span>
            <Badge variant="secondary" className="text-[10px]">
              {binding.providerKey}
            </Badge>
            {!binding.enabled && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                disabled
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
            {hooks?.preRunHydrate?.enabled && <span>hydrate</span>}
            {hooks?.postRunCapture?.enabled && <span>capture</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <ToggleSwitch
            checked={binding.enabled}
            onCheckedChange={(v) => toggleMutation.mutate(v)}
          />
          <Button variant="ghost" size="icon-sm" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive"
            onClick={() => {
              if (confirm("Delete this memory binding?")) deleteMutation.mutate();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Targets
            </span>
            <Button variant="ghost" size="sm" onClick={() => setShowAddTarget(!showAddTarget)}>
              <Plus className="h-3 w-3 mr-1" /> Add
            </Button>
          </div>

          {targets && targets.length === 0 && (
            <p className="text-xs text-muted-foreground pl-4">No targets assigned</p>
          )}
          {targets?.map((t) => (
            <TargetRow
              key={t.id}
              target={t}
              agents={agents}
              companyName={companyName}
              onRemove={() => removeTargetMutation.mutate(t.id)}
            />
          ))}

          {showAddTarget && (
            <div className="flex items-center gap-2 mt-2 pl-4">
              <select
                className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                value={addTargetType}
                onChange={(e) => {
                  setAddTargetType(e.target.value as "company" | "agent");
                  setAddTargetId(e.target.value === "company" ? companyId : "");
                }}
              >
                <option value="company">Company</option>
                <option value="agent">Agent</option>
              </select>
              {addTargetType === "agent" ? (
                <select
                  className="rounded-md border border-border bg-background px-2 py-1 text-sm flex-1"
                  value={addTargetId}
                  onChange={(e) => setAddTargetId(e.target.value)}
                >
                  <option value="">Select agent...</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-sm text-muted-foreground">{companyName} (all agents)</span>
              )}
              <Button
                size="sm"
                disabled={addTargetMutation.isPending || (!addTargetId && addTargetType === "agent")}
                onClick={() =>
                  addTargetMutation.mutate({
                    targetType: addTargetType,
                    targetId: addTargetType === "company" ? companyId : addTargetId,
                  })
                }
              >
                <Check className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────

export function MemorySettings() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editBinding, setEditBinding] = useState<MemoryBinding | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "Memory" },
    ]);
  }, [selectedCompany, setBreadcrumbs]);

  const { data: bindings, isLoading } = useQuery({
    queryKey: queryKeys.memory.bindings(selectedCompanyId!),
    queryFn: () => memoryApi.listBindings(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentList = (agents ?? []).map((a: { id: string; name: string }) => ({
    id: a.id,
    name: a.name,
  }));

  if (!selectedCompanyId) return null;

  return (
    <div className="mx-auto max-w-3xl py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Brain className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Memory Providers</h1>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setEditBinding(null);
            setDialogOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" /> New Binding
        </Button>
      </div>

      <p className="text-sm text-muted-foreground mb-6">
        Memory bindings connect provider backends (PARA, etc.) to your company and
        agents. Configure hooks to automatically hydrate agent context before runs and capture
        outcomes after.
      </p>

      {isLoading && (
        <p className="text-sm text-muted-foreground">Loading bindings...</p>
      )}

      {!isLoading && bindings?.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <Brain className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">No memory bindings configured</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => {
              setEditBinding(null);
              setDialogOpen(true);
            }}
          >
            Create first binding
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {bindings?.map((b) => (
          <BindingCard
            key={b.id}
            binding={b}
            companyId={selectedCompanyId}
            companyName={selectedCompany?.name ?? ""}
            agents={agentList}
            onEdit={() => {
              setEditBinding(b);
              setDialogOpen(true);
            }}
          />
        ))}
      </div>

      <div className="mt-8 pt-6 border-t border-border">
        <Link
          to="/memory/operations"
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <Activity className="h-4 w-4" />
          View operation log
        </Link>
      </div>

      <BindingDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        companyId={selectedCompanyId}
        existing={editBinding}
      />
    </div>
  );
}
