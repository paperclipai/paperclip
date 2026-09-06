import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, RotateCcw, CircleDot, Bot, FolderKanban, Target } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { trashApi } from "../api/trash";
import type { TrashEntityType, TrashItem } from "../api/trash";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { cn } from "../lib/utils";

const ENTITY_LABELS: Record<TrashEntityType, string> = {
  issue: "Issue",
  agent: "Agent",
  project: "Project",
  goal: "Goal",
};

const ENTITY_ICONS: Record<TrashEntityType, LucideIcon> = {
  issue: CircleDot,
  agent: Bot,
  project: FolderKanban,
  goal: Target,
};

const FILTER_OPTIONS: Array<{ value: TrashEntityType | "all"; label: string }> = [
  { value: "all", label: "Todos" },
  { value: "issue", label: "Issues" },
  { value: "agent", label: "Agents" },
  { value: "project", label: "Projects" },
  { value: "goal", label: "Goals" },
];

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function TrashPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<TrashEntityType | "all">("all");
  const [confirmDelete, setConfirmDelete] = useState<TrashItem | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Lixeira" }]);
  }, [setBreadcrumbs]);

  const entityTypeParam = filter === "all" ? undefined : filter;

  const { data: items, isLoading, error } = useQuery({
    queryKey: queryKeys.trash.list(selectedCompanyId!, filter),
    queryFn: () => trashApi.list(selectedCompanyId!, entityTypeParam),
    enabled: !!selectedCompanyId,
  });

  const restoreMutation = useMutation({
    mutationFn: (item: TrashItem) => trashApi.restore(item.entityType, item.entityId),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.trash.list(selectedCompanyId!, filter) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Falha ao restaurar item");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (item: TrashItem) => trashApi.deletePermanently(item.entityType, item.entityId),
    onSuccess: () => {
      setActionError(null);
      setConfirmDelete(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.trash.list(selectedCompanyId!, filter) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Falha ao excluir item");
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Trash2} message="Selecione uma empresa para ver a lixeira." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      {/* Filter tabs */}
      <div className="flex items-center gap-1 border-b border-border pb-1">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => setFilter(opt.value)}
            className={cn(
              "px-3 py-1.5 text-sm font-medium transition-colors",
              filter === opt.value
                ? "text-foreground border-b-2 border-foreground -mb-[5px]"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {items && items.length === 0 && (
        <EmptyState icon={Trash2} message="A lixeira está vazia." />
      )}

      {items && items.length > 0 && (
        <div className="divide-y divide-border rounded-lg border border-border">
          {items.map((item) => {
            const Icon = ENTITY_ICONS[item.entityType];
            return (
              <div key={`${item.entityType}-${item.entityId}`} className="flex items-center gap-3 px-4 py-3">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{item.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {ENTITY_LABELS[item.entityType]} · Excluído em {formatDate(item.deletedAt)}
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => restoreMutation.mutate(item)}
                    disabled={restoreMutation.isPending}
                  >
                    <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                    Restaurar
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => setConfirmDelete(item)}
                    disabled={deleteMutation.isPending}
                  >
                    <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                    Excluir
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Confirmation dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-lg border border-border bg-card p-6 max-w-sm w-full mx-4 shadow-lg">
            <h2 className="text-base font-semibold mb-2">Excluir permanentemente?</h2>
            <p className="text-sm text-muted-foreground mb-4">
              <span className="font-medium text-foreground">{confirmDelete.name}</span> será excluído permanentemente e não poderá ser recuperado.
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(null)}
                disabled={deleteMutation.isPending}
              >
                Cancelar
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => deleteMutation.mutate(confirmDelete)}
                disabled={deleteMutation.isPending}
              >
                Excluir permanentemente
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
