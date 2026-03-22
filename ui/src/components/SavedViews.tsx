import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { savedViewsApi, type SavedView, type CreateSavedViewInput } from "../api/saved-views";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Bookmark, Plus, Settings2, Pencil, Trash2, Check } from "lucide-react";
import type { IssueViewState } from "./IssuesList";

/* ── SavedViewsBar ── */

interface SavedViewsBarProps {
  viewState: IssueViewState;
  onApplyView: (patch: Partial<IssueViewState>) => void;
}

export function SavedViewsBar({ viewState, onApplyView }: SavedViewsBarProps) {
  const { selectedCompanyId } = useCompany();
  const [saveOpen, setSaveOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  const { data: savedViews = [] } = useQuery({
    queryKey: queryKeys.savedViews.list(selectedCompanyId!),
    queryFn: () => savedViewsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const isViewActive = (view: SavedView) => {
    const f = view.filters;
    return (
      arrEq(viewState.statuses, f.statuses) &&
      arrEq(viewState.priorities, f.priorities) &&
      arrEq(viewState.assignees, f.assignees) &&
      arrEq(viewState.labels, f.labels) &&
      viewState.groupBy === view.groupBy &&
      viewState.sortField === view.sortField &&
      viewState.sortDir === view.sortDirection
    );
  };

  const applyView = (view: SavedView) => {
    onApplyView({
      statuses: view.filters.statuses,
      priorities: view.filters.priorities,
      assignees: view.filters.assignees,
      labels: view.filters.labels,
      groupBy: view.groupBy as IssueViewState["groupBy"],
      sortField: view.sortField as IssueViewState["sortField"],
      sortDir: view.sortDirection as IssueViewState["sortDir"],
    });
  };

  if (!selectedCompanyId) return null;

  return (
    <>
      <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none -mx-1 px-1 pb-0.5">
        <Bookmark className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        {savedViews.map((view) => {
          const active = isViewActive(view);
          return (
            <button
              key={view.id}
              className={`px-2.5 py-1.5 sm:py-1 text-xs rounded-full border transition-colors whitespace-nowrap shrink-0 ${
                active
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
              }`}
              onClick={() => applyView(view)}
            >
              {view.name}
            </button>
          );
        })}
        <button
          className="px-2 py-1.5 sm:py-1 text-xs rounded-full border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-colors inline-flex items-center gap-1 whitespace-nowrap shrink-0"
          onClick={() => setSaveOpen(true)}
        >
          <Plus className="h-3 w-3" />
          Save View
        </button>
        {savedViews.length > 0 && (
          <button
            className="p-1.5 sm:p-1 text-muted-foreground hover:text-foreground transition-colors rounded shrink-0"
            onClick={() => setManageOpen(true)}
            title="Manage saved views"
          >
            <Settings2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <SaveViewDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        viewState={viewState}
      />

      <ManageViewsDialog
        open={manageOpen}
        onOpenChange={setManageOpen}
        viewState={viewState}
      />
    </>
  );
}

/* ── SaveViewDialog ── */

function SaveViewDialog({
  open,
  onOpenChange,
  viewState,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viewState: IssueViewState;
}) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [name, setName] = useState("");

  const createMutation = useMutation({
    mutationFn: (data: CreateSavedViewInput) =>
      savedViewsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.savedViews.list(selectedCompanyId!) });
      setName("");
      onOpenChange(false);
    },
    onError: () => {
      pushToast({ title: "Failed to save view", tone: "error" });
    },
  });

  const handleSave = () => {
    if (!name.trim()) return;
    createMutation.mutate({
      name: name.trim(),
      filters: {
        statuses: viewState.statuses,
        priorities: viewState.priorities,
        assignees: viewState.assignees,
        labels: viewState.labels,
      },
      groupBy: viewState.groupBy,
      sortField: viewState.sortField,
      sortDirection: viewState.sortDir,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setName(""); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Save Current View</DialogTitle>
          <DialogDescription>
            Save the current filter, sort, and group settings as a named view.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Input
            placeholder="View name..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            autoFocus
          />
          <ViewStateSummary viewState={viewState} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!name.trim() || createMutation.isPending}>
            {createMutation.isPending ? "Saving..." : "Save View"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── ManageViewsDialog ── */

function ManageViewsDialog({
  open,
  onOpenChange,
  viewState,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  viewState: IssueViewState;
}) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  const { data: savedViews = [] } = useQuery({
    queryKey: queryKeys.savedViews.list(selectedCompanyId!),
    queryFn: () => savedViewsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.savedViews.list(selectedCompanyId!) });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof savedViewsApi.update>[2] }) =>
      savedViewsApi.update(selectedCompanyId!, id, data),
    onSuccess: invalidate,
    onError: () => {
      pushToast({ title: "Failed to update view", tone: "error" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => savedViewsApi.remove(selectedCompanyId!, id),
    onSuccess: invalidate,
    onError: () => {
      pushToast({ title: "Failed to delete view", tone: "error" });
    },
  });

  const startEdit = (view: SavedView) => {
    setEditingId(view.id);
    setEditName(view.name);
  };

  const confirmEdit = () => {
    if (!editingId || !editName.trim()) return;
    updateMutation.mutate({ id: editingId, data: { name: editName.trim() } });
    setEditingId(null);
  };

  const updateFilters = (view: SavedView) => {
    updateMutation.mutate({
      id: view.id,
      data: {
        filters: {
          statuses: viewState.statuses,
          priorities: viewState.priorities,
          assignees: viewState.assignees,
          labels: viewState.labels,
        },
        groupBy: viewState.groupBy,
        sortField: viewState.sortField,
        sortDirection: viewState.sortDir,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Manage Saved Views</DialogTitle>
          <DialogDescription>
            Rename, update, or delete your team's saved views.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 py-2 max-h-[60vh] overflow-y-auto">
          {savedViews.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No saved views yet.
            </p>
          )}
          {savedViews.map((view) => (
            <div
              key={view.id}
              className="flex items-center gap-2 px-2 py-2 rounded-md hover:bg-accent/50 group"
            >
              {editingId === view.id ? (
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") confirmEdit(); if (e.key === "Escape") setEditingId(null); }}
                    className="h-7 text-sm"
                    autoFocus
                  />
                  <Button size="icon-xs" variant="ghost" onClick={confirmEdit}>
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <>
                  <Bookmark className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="text-sm flex-1 min-w-0 truncate">{view.name}</span>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => startEdit(view)}
                      title="Rename"
                    >
                      <Pencil className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => updateFilters(view)}
                      title="Update to current filters"
                    >
                      <Settings2 className="h-3 w-3" />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deleteMutation.mutate(view.id)}
                      title="Delete"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}

/* ── Helpers ── */

function arrEq(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function ViewStateSummary({ viewState }: { viewState: IssueViewState }) {
  const parts: string[] = [];
  if (viewState.statuses.length > 0) parts.push(`${viewState.statuses.length} status filter${viewState.statuses.length > 1 ? "s" : ""}`);
  if (viewState.priorities.length > 0) parts.push(`${viewState.priorities.length} priority filter${viewState.priorities.length > 1 ? "s" : ""}`);
  if (viewState.assignees.length > 0) parts.push(`${viewState.assignees.length} assignee filter${viewState.assignees.length > 1 ? "s" : ""}`);
  if (viewState.labels.length > 0) parts.push(`${viewState.labels.length} label filter${viewState.labels.length > 1 ? "s" : ""}`);
  if (viewState.groupBy !== "none") parts.push(`grouped by ${viewState.groupBy}`);
  parts.push(`sorted by ${viewState.sortField} ${viewState.sortDir}`);

  return (
    <div className="text-xs text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
      {parts.length > 0 ? parts.join(" · ") : "No active filters"}
    </div>
  );
}
