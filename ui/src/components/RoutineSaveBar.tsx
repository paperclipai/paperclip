import { t, useTranslation, Trans } from "@/i18n";
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { RoutineHistoryDirtyFieldDescriptor } from "./RoutineHistoryTab";

/**
 * Per-section sticky save bar (§1.4–§1.5). Hidden when clean; reveals on dirty.
 * On a 409 it swaps to the conflict-recovery surface ("Reload latest" /
 * "Overwrite anyway"). Wires ⌘/Ctrl+S → save and Esc → discard-with-confirm.
 */
export function RoutineSaveBar({
  dirtyFields,
  isSaving,
  saveConflict,
  onSave,
  onDiscard,
  onReload,
  disabled,
}: {
  dirtyFields: RoutineHistoryDirtyFieldDescriptor[];
  isSaving: boolean;
  saveConflict: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onReload: () => void;
  disabled?: boolean;
}) {
  useTranslation("task-components");
  const dirtyCount = dirtyFields.length;
  const isDirty = dirtyCount > 0;
  const [confirmDiscardOpen, setConfirmDiscardOpen] = useState(false);

  useEffect(() => {
    if (!isDirty && !saveConflict) return;
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (!isSaving && !disabled) onSave();
      } else if (event.key === "Escape" && isDirty) {
        event.preventDefault();
        setConfirmDiscardOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isDirty, saveConflict, isSaving, disabled, onSave]);

  if (!isDirty && !saveConflict) return null;

  return (
    <>
      <div
        className={cn(
          "sticky bottom-0 z-10 -mx-8 mt-6 flex h-14 items-center justify-between border-t px-8 backdrop-blur",
          "motion-safe:transition-colors motion-safe:duration-200",
          "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2",
          saveConflict
            ? "border-amber-500/30 bg-amber-500/5"
            : "border-border bg-background/95",
        )}
      >
        {saveConflict ? (
          <div className="flex items-center gap-2 text-sm text-amber-800 dark:text-amber-200">
            <AlertTriangle className="h-4 w-4" />
            <span>{t("task-components:routineChangedElsewhereReloadToMerge_3148fbdb")}</span>
          </div>
        ) : (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 text-sm text-foreground hover:text-foreground"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                <span className="font-medium"><Trans ns="final-components-a" i18nKey="numeric_62a7feab4187" values={{ dirtyCount: dirtyCount }} components={{ part2: <>{dirtyCount === 1 ? t("task-components:change_12ea12ea") : t("task-components:changes_d0b4ba23")}</> }} /></span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64">
              <p className="mb-2 text-xs font-medium text-muted-foreground">{t("task-components:pendingChanges_54ae644f")}</p>
              <ul className="space-y-1 text-sm">
                {dirtyFields.map((field) => (
                  <li key={field.key} className="flex items-center gap-2">
                    <span className="h-1 w-1 rounded-full bg-amber-500" />
                    <span className="capitalize">{field.label}</span>
                  </li>
                ))}
              </ul>
            </PopoverContent>
          </Popover>
        )}

        <div className="flex items-center gap-2">
          {saveConflict ? (
            <>
              <Button variant="outline" size="sm" onClick={onReload}>{t("task-components:reloadLatest_cb5bbbf3")}</Button>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={isSaving || disabled}
                      onClick={onSave}
                    >
                      {isSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{t("task-components:overwriteAnyway_9511749c")}</Button>
                  </TooltipTrigger>
                  <TooltipContent>{t("task-components:replacesTheNewerRevisionWithYourLocal_fec05c5b")}</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                disabled={isSaving || disabled}
                onClick={() => setConfirmDiscardOpen(true)}
              >{t("task-components:discard_eb1a70e3")}</Button>
              <Button
                size="sm"
                disabled={isSaving || disabled}
                onClick={onSave}
              >
                {isSaving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{t("task-components:saveChanges_dd0ae7a5")}<kbd className="ml-2 hidden rounded bg-foreground/10 px-1 text-(length:--text-nano) font-medium sm:inline">
                  ⌘S
                </kbd>
              </Button>
            </>
          )}
        </div>
      </div>

      <Dialog open={confirmDiscardOpen} onOpenChange={setConfirmDiscardOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("task-components:discardChanges_85bcf416")}</DialogTitle>
            <DialogDescription><Trans ns="final-components-a" i18nKey="numeric_3b936e23af16" values={{ dirtyCount: dirtyCount }} components={{ part2: <>{dirtyCount === 1 ? t("task-components:change_12ea12ea") : t("task-components:changes_d0b4ba23")}</> }} /></DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscardOpen(false)}>{t("task-components:keepEditing_e76fd2ad")}</Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onDiscard();
                setConfirmDiscardOpen(false);
              }}
            >{t("task-components:discardChanges_f9bfa3dc")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Read-only strip for non-owners on editable sections (§1.6). */
export function RoutineReadOnlyStrip() {
  useTranslation("task-components");
  return (
    <div className="-mx-8 mt-6 border-t border-border bg-muted/20 px-8 py-3 text-xs text-muted-foreground">{t("task-components:readOnlyYouDonTOwnThis_ed056afb")}</div>
  );
}
