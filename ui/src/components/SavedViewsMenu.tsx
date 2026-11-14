import { useEffect, useState } from "react";
import { Bookmark, Check, Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "../lib/utils";
import {
  createSavedView,
  deleteSavedView,
  loadSavedViews,
  persistSavedViews,
  renameSavedView,
  type SavedView,
} from "../lib/saved-issue-views";
import type { SavedViewsLocation, SavedViewNormalizers } from "../lib/saved-issue-views";

interface SavedViewsMenuProps<TViewState, TColumn extends string> {
  companyId: string | null;
  collectionKey: string;
  snapshotViewState: TViewState;
  snapshotColumns: TColumn[];
  normalizers: SavedViewNormalizers<TViewState, TColumn>;
  onApply: (view: SavedView<TViewState, TColumn>) => void;
}

function errorLabel(code: string): string {
  switch (code) {
    case "name-required":
      return "Enter a name for this view.";
    case "duplicate-name":
      return "A view with this name already exists.";
    case "limit-reached":
      return "View limit reached. Delete a view first.";
    case "not-found":
      return "That view no longer exists.";
    case "storage-unavailable":
      return "Could not save views. Browser storage is unavailable or full.";
    default:
      return "Could not save this view.";
  }
}

export function SavedViewsMenu<TViewState, TColumn extends string>({
  companyId,
  collectionKey,
  snapshotViewState,
  snapshotColumns,
  normalizers,
  onApply,
}: SavedViewsMenuProps<TViewState, TColumn>) {
  const [open, setOpen] = useState(false);
  const location: SavedViewsLocation = {
    companyId: companyId ?? "__unscoped__",
    collectionKey,
  };
  const [views, setViews] = useState<Array<SavedView<TViewState, TColumn>>>(() =>
    loadSavedViews(location, normalizers),
  );
  const [draftName, setDraftName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  useEffect(() => {
    setViews(loadSavedViews(location, normalizers));
    setDraftName("");
    setSaveError(null);
    setEditingId(null);
    setRenameError(null);
    // Reload when the storage scope changes. Normalizers are stable module fns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.companyId, location.collectionKey]);

  const handleSave = () => {
    const result = createSavedView(views, {
      name: draftName,
      viewState: snapshotViewState,
      columns: snapshotColumns,
    });
    if ("error" in result) {
      setSaveError(errorLabel(result.error));
      return;
    }
    if (!persistSavedViews(location, result.views)) {
      setSaveError(errorLabel("storage-unavailable"));
      return;
    }
    setViews(result.views);
    setDraftName("");
    setSaveError(null);
  };

  const handleApply = (view: SavedView<TViewState, TColumn>) => {
    onApply(view);
    setOpen(false);
  };

  const handleDelete = (id: string) => {
    const next = deleteSavedView(views, id);
    if (!persistSavedViews(location, next)) {
      setSaveError(errorLabel("storage-unavailable"));
      return;
    }
    setViews(next);
    if (editingId === id) {
      setEditingId(null);
      setRenameError(null);
    }
  };

  const handleRename = (id: string) => {
    const result = renameSavedView(views, id, editName);
    if ("error" in result) {
      setRenameError(errorLabel(result.error));
      return;
    }
    if (!persistSavedViews(location, result.views)) {
      setRenameError(errorLabel("storage-unavailable"));
      return;
    }
    setViews(result.views);
    setEditingId(null);
    setRenameError(null);
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2"
          title="Saved views"
          aria-label={views.length > 0 ? `Saved views (${views.length})` : "Saved views"}
        >
          <Bookmark className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Views</span>
          {views.length > 0 ? (
            <span className="min-w-4 text-xs tabular-nums text-muted-foreground">{views.length}</span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72 p-0">
        <div className="p-2">
          <DropdownMenuLabel className="px-2 py-1">Saved views</DropdownMenuLabel>
          <div className="flex items-center gap-1.5 px-2 py-1.5">
            <Input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") handleSave();
              }}
              placeholder="Save current filters as…"
              aria-label="Name for the current view"
              className="h-8"
            />
            <Button
              type="button"
              size="sm"
              className="h-8 shrink-0"
              onClick={handleSave}
              disabled={draftName.trim().length === 0}
            >
              Save
            </Button>
          </div>
          {saveError ? (
            <p className="px-2 pb-1 text-xs text-destructive" role="alert">{saveError}</p>
          ) : null}
        </div>
        <DropdownMenuSeparator />
        <div className="max-h-64 overflow-y-auto p-2">
          {views.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">
              No saved views yet. Set filters, then save them here.
            </p>
          ) : (
            views.map((view) => (
              <div key={view.id} className="group flex items-center gap-0.5 rounded-sm">
                {editingId === view.id ? (
                  <>
                    <Input
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleRename(view.id);
                        if (event.key === "Escape") {
                          setEditingId(null);
                          setRenameError(null);
                        }
                      }}
                      aria-label={`Rename ${view.name}`}
                      className="h-8"
                      autoFocus
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0"
                      onClick={() => handleRename(view.id)}
                      title="Confirm rename"
                      aria-label={`Confirm rename of ${view.name}`}
                    >
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0"
                      onClick={() => {
                        setEditingId(null);
                        setRenameError(null);
                      }}
                      title="Cancel rename"
                      aria-label={`Cancel rename of ${view.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className={cn(
                        "flex min-w-0 flex-1 items-center rounded-sm px-2 py-1.5 text-sm",
                        "text-foreground hover:bg-accent/50",
                      )}
                      onClick={() => handleApply(view)}
                      title={`Apply ${view.name}`}
                    >
                      <span className="truncate">{view.name}</span>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => {
                        setEditingId(view.id);
                        setEditName(view.name);
                        setRenameError(null);
                      }}
                      title={`Rename ${view.name}`}
                      aria-label={`Rename ${view.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="shrink-0 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                      onClick={() => handleDelete(view.id)}
                      title={`Delete ${view.name}`}
                      aria-label={`Delete ${view.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                )}
              </div>
            ))
          )}
          {renameError ? (
            <p className="px-2 pt-1 text-xs text-destructive" role="alert">{renameError}</p>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
