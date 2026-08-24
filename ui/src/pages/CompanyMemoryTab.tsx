import { useCallback, useState, useRef, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Brain,
  Database,
  Settings2,
  Trash2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Pencil,
} from "lucide-react";
import { memoryApi, type MemoryBinding, type MemoryTarget } from "../api/memory";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// ─── Create/Edit Binding Dialog ─────────────────────────────────────────────

function BindingFormDialog({
  open,
  onOpenChange,
  binding,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  binding?: MemoryBinding | null;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!binding;
  const [key, setKey] = useState(binding?.key ?? "");
  const [providerType, setProviderType] = useState(binding?.providerType ?? "builtin_pgvector");
  const [enabled, setEnabled] = useState(binding?.enabled ?? true);

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setKey(binding?.key ?? "");
      setProviderType(binding?.providerType ?? "builtin_pgvector");
      setEnabled(binding?.enabled ?? true);
    }
  }, [open, binding]);

  const createMutation = useMutation({
    mutationFn: () =>
      memoryApi.createBinding(companyId, { key, providerType, enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.bindings(companyId) });
      onOpenChange(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: () =>
      memoryApi.updateBinding(companyId, binding!.id, { key, enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.bindings(companyId) });
      onOpenChange(false);
    },
  });

  const isPending = createMutation.isPending || updateMutation.isPending;
  const error = createMutation.error || updateMutation.error;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) return;
    if (isEdit) {
      updateMutation.mutate();
    } else {
      createMutation.mutate();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Binding" : "Create Binding"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update the memory binding configuration."
              : "Add a new memory binding to configure how memory is stored and queried."}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Binding Key</label>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="e.g., default, mem0-prod"
              disabled={isEdit}
              required
            />
            <p className="text-xs text-muted-foreground">
              A unique identifier for this binding within the company.
            </p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Provider Type</label>
            <Select
              value={providerType}
              onValueChange={setProviderType}
              disabled={isEdit}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="builtin_pgvector">Built-in (pgvector)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The memory provider backend. Currently only the built-in pgvector adapter is available.
            </p>
          </div>
          {error && (
            <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error instanceof Error ? error.message : "Failed to save binding"}
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !key.trim()}>
              {isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  {isEdit ? "Updating..." : "Creating..."}
                </>
              ) : isEdit ? (
                "Update Binding"
              ) : (
                "Create Binding"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Delete Confirmation Dialog ──────────────────────────────────────────────

function DeleteBindingDialog({
  open,
  onOpenChange,
  binding,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  binding: MemoryBinding | null;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: () => memoryApi.deleteBinding(companyId, binding!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.bindings(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.targets(companyId) });
      onOpenChange(false);
    },
  });

  if (!binding) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Binding</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the binding "{binding.key}"? This will
            remove all associated memory records and targets. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        {deleteMutation.error && (
          <div className="flex items-center gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {deleteMutation.error instanceof Error ? deleteMutation.error.message : "Failed to delete binding"}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => deleteMutation.mutate()}
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Deleting...
              </>
            ) : (
              <>
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Delete
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Binding Card ────────────────────────────────────────────────────────────

function BindingCard({
  binding,
  isDefault,
  onEdit,
  onDelete,
  onSetDefault,
}: {
  binding: MemoryBinding;
  isDefault: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSetDefault: () => void;
}) {
  return (
    <div className="group relative rounded-lg border border-border bg-card p-4 transition-colors hover:border-border/80">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-sm">{binding.key}</span>
            {isDefault && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                Default
              </Badge>
            )}
            <Badge
              variant={binding.enabled ? "default" : "secondary"}
              className="text-[10px] px-1.5 py-0"
            >
              {binding.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <div className="text-xs text-muted-foreground space-y-0.5">
            <p>Provider: {binding.providerType}</p>
            {binding.configJson && Object.keys(binding.configJson).length > 0 && (
              <p>Config: {JSON.stringify(binding.configJson)}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {!isDefault && binding.enabled && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="h-7 w-7"
                  onClick={onSetDefault}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Set as company default</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7"
                onClick={onEdit}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Edit binding</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Delete binding</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export function CompanyMemoryTab() {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  // Dialogs
  const [createOpen, setCreateOpen] = useState(false);
  const [editBinding, setEditBinding] = useState<MemoryBinding | null>(null);
  const [deleteBinding, setDeleteBinding] = useState<MemoryBinding | null>(null);

  // Queries
  const bindingsQuery = useQuery({
    queryKey: queryKeys.memory.bindings(selectedCompanyId!),
    queryFn: () => memoryApi.bindings(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const targetsQuery = useQuery({
    queryKey: queryKeys.memory.targets(selectedCompanyId!),
    queryFn: () => memoryApi.listTargets(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const bindings = bindingsQuery.data ?? [];
  const targets = targetsQuery.data ?? [];

  // Find the company-level default target
  const defaultTarget = targets.find((t) => t.targetType === "company");
  const defaultBindingId = defaultTarget?.bindingId ?? null;

  // Set default mutation
  const setDefaultMutation = useMutation({
    mutationFn: async (bindingId: string) => {
      // Remove existing company default if any
      if (defaultTarget) {
        await memoryApi.deleteTarget(selectedCompanyId!, defaultTarget.id);
      }
      // Create new company default target
      await memoryApi.createTarget(selectedCompanyId!, {
        targetType: "company",
        targetId: selectedCompanyId!,
        bindingId,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.bindings(selectedCompanyId!) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.memory.targets(selectedCompanyId!) });
    },
  });

  const handleSetDefault = useCallback(
    (bindingId: string) => {
      setDefaultMutation.mutate(bindingId);
    },
    [setDefaultMutation],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={Brain} message="Select a company to manage memory settings." />;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Memory Bindings</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Configure how memory is stored and queried for your company and agents.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Binding
        </Button>
      </div>

      {bindingsQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading bindings...
        </div>
      )}

      {bindingsQuery.error && (
        <div className="flex items-center gap-2 rounded-lg border border-border p-4 text-sm text-destructive">
          <AlertCircle className="h-4 w-4" />
          {(bindingsQuery.error as Error).message}
        </div>
      )}

      {bindingsQuery.isFetched && bindings.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-10">
          <EmptyState
            icon={Database}
            message="No memory bindings configured."
          />
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Create your first binding
          </Button>
        </div>
      )}

      {bindings.length > 0 && (
        <div className="space-y-2">
          {bindings.map((binding) => (
            <BindingCard
              key={binding.id}
              binding={binding}
              isDefault={binding.id === defaultBindingId}
              onEdit={() => setEditBinding(binding)}
              onDelete={() => setDeleteBinding(binding)}
              onSetDefault={() => handleSetDefault(binding.id)}
            />
          ))}
        </div>
      )}

      {/* Dialogs */}
      <BindingFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        companyId={selectedCompanyId}
      />

      <BindingFormDialog
        open={!!editBinding}
        onOpenChange={(open) => {
          if (!open) setEditBinding(null);
        }}
        binding={editBinding}
        companyId={selectedCompanyId}
      />

      <DeleteBindingDialog
        open={!!deleteBinding}
        onOpenChange={(open) => {
          if (!open) setDeleteBinding(null);
        }}
        binding={deleteBinding}
        companyId={selectedCompanyId}
      />

      {/* Set default progress */}
      {setDefaultMutation.isPending && (
        <div className="fixed bottom-4 right-4 flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 shadow-lg text-sm">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Setting default binding...
        </div>
      )}
    </div>
  );
}
