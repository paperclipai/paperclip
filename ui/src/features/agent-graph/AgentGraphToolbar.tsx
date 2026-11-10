import { ArrowDownUp, ArrowLeftRight, Eye, Keyboard, LayoutGrid, Redo2, StickyNote, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { UiLayoutSaveState } from "@/hooks/useUiLayout";
import type { LayoutDirection } from "./lib/auto-layout";

export const AGENT_GRAPH_SHORTCUTS: ReadonlyArray<{ keys: string; action: string }> = [
  { keys: "Drag", action: "Move a node or pan the canvas" },
  { keys: "Shift + drag", action: "Select with a box" },
  { keys: "Ctrl/⌘ + click", action: "Add to the selection" },
  { keys: "Ctrl/⌘ + A", action: "Select everything" },
  { keys: "Ctrl/⌘ + C / V", action: "Copy and paste. Agents paste as hire drafts" },
  { keys: "Ctrl/⌘ + D", action: "Duplicate the selection" },
  { keys: "Ctrl/⌘ + Z", action: "Undo" },
  { keys: "Ctrl/⌘ + Shift + Z", action: "Redo" },
  { keys: "Delete", action: "Remove selected notes and drafts, or a reporting line" },
  { keys: "Arrow keys", action: "Move the focused node" },
  { keys: "Tab", action: "Move focus between nodes" },
  { keys: "Escape", action: "Clear the selection" },
];

const SAVE_LABELS: Record<UiLayoutSaveState, string> = {
  idle: "",
  pending: "Unsaved changes",
  saving: "Saving…",
  saved: "Layout saved",
  error: "Layout not saved",
};

export function AgentGraphToolbar({
  direction,
  keepManual,
  hiddenCount,
  canUndo,
  canRedo,
  saveState,
  onAddSticky,
  onTidy,
  onDirectionChange,
  onKeepManualChange,
  onShowHidden,
  onUndo,
  onRedo,
}: {
  direction: LayoutDirection;
  keepManual: boolean;
  hiddenCount: number;
  canUndo: boolean;
  canRedo: boolean;
  saveState: UiLayoutSaveState;
  onAddSticky: () => void;
  onTidy: () => void;
  onDirectionChange: (direction: LayoutDirection) => void;
  onKeepManualChange: (keep: boolean) => void;
  onShowHidden: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Agent graph tools"
      className="flex max-w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-card p-1 shadow-sm"
    >
      <Button variant="ghost" size="sm" onClick={onAddSticky}>
        <StickyNote aria-hidden />
        Add note
      </Button>
      <Button variant="ghost" size="sm" onClick={onTidy}>
        <LayoutGrid aria-hidden />
        Tidy up
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={direction === "TB" ? "Switch to left-to-right layout" : "Switch to top-down layout"}
        onClick={() => onDirectionChange(direction === "TB" ? "LR" : "TB")}
      >
        {direction === "TB" ? <ArrowDownUp aria-hidden /> : <ArrowLeftRight aria-hidden />}
        {direction === "TB" ? "Top-down" : "Left-right"}
      </Button>
      <label className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          className="accent-primary"
          checked={keepManual}
          onChange={(event) => onKeepManualChange(event.target.checked)}
        />
        Keep manual positions
      </label>
      <Button variant="ghost" size="icon-sm" aria-label="Undo" disabled={!canUndo} onClick={onUndo}>
        <Undo2 aria-hidden />
      </Button>
      <Button variant="ghost" size="icon-sm" aria-label="Redo" disabled={!canRedo} onClick={onRedo}>
        <Redo2 aria-hidden />
      </Button>
      {hiddenCount > 0 ? (
        <Button variant="ghost" size="sm" onClick={onShowHidden}>
          <Eye aria-hidden />
          Show {hiddenCount} hidden
        </Button>
      ) : null}
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Keyboard shortcuts">
            <Keyboard aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80">
          <h3 className="mb-2 text-sm font-semibold">Keyboard shortcuts</h3>
          <dl className="grid grid-cols-5 gap-x-2 gap-y-1 text-xs">
            {AGENT_GRAPH_SHORTCUTS.map((shortcut) => (
              <div key={shortcut.keys} className="col-span-5 grid grid-cols-subgrid">
                <dt className="col-span-2 font-mono text-muted-foreground">{shortcut.keys}</dt>
                <dd className="col-span-3">{shortcut.action}</dd>
              </div>
            ))}
          </dl>
        </PopoverContent>
      </Popover>
      <span
        role="status"
        aria-live="polite"
        className={saveState === "error" ? "px-2 text-xs text-destructive" : "px-2 text-xs text-muted-foreground"}
      >
        {SAVE_LABELS[saveState]}
      </span>
    </div>
  );
}
