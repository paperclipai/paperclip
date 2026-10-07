import { useEffect, useState, type FormEvent } from "react";
import { Bookmark, Check, Copy, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { SavedTaskView } from "@paperclipai/shared";
import { SAVED_TASK_VIEW_NAME_MAX_LENGTH } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToastActions } from "@/context/ToastContext";
import { suggestSavedViewCopyName } from "@/lib/saved-task-views";
import type { UseSavedTaskViewsResult } from "@/hooks/useSavedTaskViews";

type NamePrompt =
  | { mode: "create"; title: string; initialName: string }
  | { mode: "saveAs"; title: string; initialName: string }
  | { mode: "rename"; title: string; initialName: string; view: SavedTaskView };

function errorMessage(error: unknown, fallback: string): string {
  const message = (error as { message?: string } | null)?.message;
  return message && message.length > 0 ? message : fallback;
}

/**
 * Save / Update / Save as / Rename / Delete for the view the user is looking
 * at. Sits next to the Views menu so the menu stays a picker and this stays
 * the place that changes things.
 *
 * On a phone the trigger collapses to its icon and the dialogs are the
 * platform's own full-width sheets, so nothing here needs a separate mobile
 * layout.
 */
export function SavedTaskViewActions({
  savedViews,
  activeView,
  currentViewState,
  hasUnsavedChanges,
  saveBlockedReason,
  onSaved,
  onDeleted,
}: {
  savedViews: UseSavedTaskViewsResult;
  /** The saved view currently open, or `null` on a built-in view. */
  activeView: SavedTaskView | null;
  /** The view state as it stands now, including any unsaved edits. */
  currentViewState: Record<string, unknown> | null;
  hasUnsavedChanges: boolean;
  /**
   * Why this list cannot be saved, if it cannot — a narrowing the view state
   * does not hold, so a saved view would quietly show the wrong tasks. Shown
   * to the user rather than failing silently.
   */
  saveBlockedReason?: string | null;
  onSaved: (view: SavedTaskView) => void;
  onDeleted: () => void;
}) {
  const { pushToast } = useToastActions();
  const [prompt, setPrompt] = useState<NamePrompt | null>(null);
  const [name, setName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<SavedTaskView | null>(null);

  useEffect(() => {
    if (prompt) setName(prompt.initialName);
  }, [prompt]);

  const busy = savedViews.create.isPending || savedViews.update.isPending || savedViews.remove.isPending;
  // Nothing to save until the collection has reported its state — and nothing
  // worth saving when the list is narrowed by something a view cannot hold.
  const canSave = currentViewState !== null && savedViews.isAvailable && !saveBlockedReason;

  async function submitName(event: FormEvent) {
    event.preventDefault();
    if (!prompt) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      if (prompt.mode === "rename") {
        const updated = await savedViews.update.mutateAsync({ id: prompt.view.id, name: trimmed });
        setPrompt(null);
        onSaved(updated);
        pushToast({ title: `Renamed to "${updated.name}"`, tone: "success" });
        return;
      }
      if (!currentViewState) return;
      const created = await savedViews.create.mutateAsync({ name: trimmed, viewState: currentViewState });
      setPrompt(null);
      onSaved(created);
      pushToast({ title: `Saved view "${created.name}"`, tone: "success" });
    } catch (error) {
      pushToast({
        title: "Could not save the view",
        body: errorMessage(error, "Try a different name."),
        tone: "error",
      });
    }
  }

  async function updateCurrent() {
    if (!activeView || !currentViewState) return;
    try {
      const updated = await savedViews.update.mutateAsync({
        id: activeView.id,
        viewState: currentViewState,
      });
      onSaved(updated);
      pushToast({ title: `Updated "${updated.name}"`, tone: "success" });
    } catch (error) {
      pushToast({
        title: "Could not update the view",
        body: errorMessage(error, "Please try again."),
        tone: "error",
      });
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await savedViews.remove.mutateAsync(deleteTarget.id);
      const deletedName = deleteTarget.name;
      setDeleteTarget(null);
      onDeleted();
      pushToast({ title: `Deleted "${deletedName}"`, tone: "success" });
    } catch (error) {
      pushToast({
        title: "Could not delete the view",
        body: errorMessage(error, "Please try again."),
        tone: "error",
      });
    }
  }

  if (!savedViews.isAvailable) return null;

  return (
    <>
      {/* On a built-in view, or an unchanged saved view, the one useful action
          is "save this as a view" — so it gets the button rather than hiding
          in the overflow menu. */}
      {activeView === null ? (
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5"
          disabled={!canSave || busy}
          title={saveBlockedReason ?? undefined}
          onClick={() => setPrompt({ mode: "create", title: "Save view", initialName: "" })}
        >
          <Bookmark aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Save view</span>
          <span className="sr-only sm:hidden">Save view</span>
        </Button>
      ) : (
        <Button
          size="sm"
          variant={hasUnsavedChanges ? "default" : "outline"}
          className="h-8 gap-1.5"
          disabled={!canSave || busy || !hasUnsavedChanges}
          onClick={() => void updateCurrent()}
          title={saveBlockedReason
            ?? (hasUnsavedChanges ? `Update "${activeView.name}"` : "No unsaved changes")}
        >
          <Check aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">{hasUnsavedChanges ? "Update view" : "Saved"}</span>
          <span className="sr-only sm:hidden">
            {hasUnsavedChanges ? `Update ${activeView.name}` : "No unsaved changes"}
          </span>
        </Button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="outline" className="h-8 w-8" aria-label="View actions">
            <MoreHorizontal aria-hidden="true" className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-(--sz-220px)">
          <DropdownMenuItem
            disabled={!canSave || busy}
            onSelect={() =>
              setPrompt({
                mode: "saveAs",
                title: activeView ? "Save as new view" : "Save view",
                initialName: activeView
                  ? suggestSavedViewCopyName(savedViews.views, activeView.name, SAVED_TASK_VIEW_NAME_MAX_LENGTH)
                  : "",
              })
            }
          >
            <Copy aria-hidden="true" className="size-3.5" />
            {activeView ? "Save as new view…" : "Save view…"}
          </DropdownMenuItem>
          {activeView ? (
            <>
              <DropdownMenuItem
                disabled={busy}
                onSelect={() =>
                  setPrompt({
                    mode: "rename",
                    title: "Rename view",
                    initialName: activeView.name,
                    view: activeView,
                  })
                }
              >
                <Pencil aria-hidden="true" className="size-3.5" />
                Rename…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={busy}
                onSelect={() => setDeleteTarget(activeView)}
              >
                <Trash2 aria-hidden="true" className="size-3.5" />
                Delete view…
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={prompt !== null} onOpenChange={(open) => { if (!open) setPrompt(null); }}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={(event) => void submitName(event)}>
            <DialogHeader>
              <DialogTitle>{prompt?.title ?? "Save view"}</DialogTitle>
              <DialogDescription>
                {prompt?.mode === "rename"
                  ? "Only the name changes. The filters stay as they are."
                  : "Saves the filters, sort, grouping, and layout you have now — not the tasks themselves."}
              </DialogDescription>
            </DialogHeader>
            <div className="py-4">
              <Input
                autoFocus
                value={name}
                maxLength={SAVED_TASK_VIEW_NAME_MAX_LENGTH}
                placeholder="Ready to start"
                aria-label="View name"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setPrompt(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={name.trim().length === 0 || busy}>
                {prompt?.mode === "rename" ? "Rename" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete "{deleteTarget?.name}"?</DialogTitle>
            <DialogDescription>
              This removes the saved view. No tasks are changed or deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void confirmDelete()}>
              Delete view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
