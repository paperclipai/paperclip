import { useState } from "react";
import type { IssueLabel } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { Plus, Trash2 } from "lucide-react";

export function CompanyLabelEditor({
  labels,
  selectedLabelIds,
  onToggleLabel,
  onCreateLabel,
  onDeleteLabel,
  autoFocus = true,
}: {
  labels: IssueLabel[];
  selectedLabelIds: string[];
  onToggleLabel: (labelId: string) => void;
  onCreateLabel: (input: { name: string; color: string }) => Promise<unknown>;
  onDeleteLabel: (labelId: string) => Promise<unknown> | void;
  autoFocus?: boolean;
}) {
  const [labelSearch, setLabelSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");
  const [isCreating, setIsCreating] = useState(false);

  const visibleLabels = labels.filter((label) => {
    if (!labelSearch.trim()) return true;
    return label.name.toLowerCase().includes(labelSearch.toLowerCase());
  });

  return (
    <>
      <input
        className="mb-1 w-full border-b border-border bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50"
        placeholder="Search labels..."
        value={labelSearch}
        onChange={(event) => setLabelSearch(event.target.value)}
        autoFocus={autoFocus}
      />
      <div className="max-h-44 space-y-0.5 overflow-y-auto overscroll-contain">
        {visibleLabels.map((label) => {
          const selected = selectedLabelIds.includes(label.id);
          return (
            <div key={label.id} className="flex items-center gap-1">
              <button
                type="button"
                className={cn(
                  "flex flex-1 items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                  selected && "bg-accent",
                )}
                onClick={() => onToggleLabel(label.id)}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
                <span className="truncate">{label.name}</span>
              </button>
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  void Promise.resolve(onDeleteLabel(label.id));
                }}
                title={`Delete ${label.name}`}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>
      <div className="mt-2 space-y-1 border-t border-border pt-2">
        <div className="flex items-center gap-1">
          <input
            className="h-7 w-7 rounded bg-transparent p-0"
            type="color"
            value={newLabelColor}
            onChange={(event) => setNewLabelColor(event.target.value)}
          />
          <input
            className="flex-1 rounded bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50"
            placeholder="New label"
            value={newLabelName}
            onChange={(event) => setNewLabelName(event.target.value)}
          />
        </div>
        <button
          type="button"
          className="flex w-full items-center justify-center gap-1.5 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent/50 disabled:opacity-50"
          disabled={!newLabelName.trim() || isCreating}
          onClick={async () => {
            if (!newLabelName.trim() || isCreating) return;
            setIsCreating(true);
            try {
              await onCreateLabel({
                name: newLabelName.trim(),
                color: newLabelColor,
              });
              setNewLabelName("");
            } finally {
              setIsCreating(false);
            }
          }}
        >
          <Plus className="h-3 w-3" />
          {isCreating ? "Creating..." : "Create label"}
        </button>
      </div>
    </>
  );
}
