import { useState } from "react";
import { cn } from "@/lib/utils";
import { hunkLabel } from "./diff-lines";
import type { TaskChatDiffLine } from "./task-chat-model";

/** `+12 −3` in the diff hues. Unknown counts are omitted, not shown as zero. */
export function TaskChatDiffCounts({
  added,
  removed,
  className,
}: {
  added: number | null | undefined;
  removed: number | null | undefined;
  className?: string;
}) {
  if (added == null && removed == null) return null;
  // A pure addition or deletion reads cleaner without the empty side.
  const showAdded = added != null && (added > 0 || !removed);
  const showRemoved = removed != null && (removed > 0 || !added);
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1 font-mono tabular-nums", className)}
      data-testid="task-chat-diff-counts"
    >
      {showAdded ? <span className="text-(--diff-add-fg)">+{added}</span> : null}
      {showRemoved ? <span className="text-(--diff-remove-fg)">−{removed}</span> : null}
    </span>
  );
}

const MARKER: Record<TaskChatDiffLine["kind"], string> = {
  add: "+",
  remove: "−",
  context: " ",
  hunk: "",
  file: "",
};

/**
 * Compact unified diff for one file. Long diffs show the first `previewLines`
 * lines with a control to reveal the rest; the block scrolls inside a fixed
 * maximum height so a large edit never pushes the conversation away.
 */
export function TaskChatDiffView({
  lines,
  truncated = false,
  previewLines = 24,
  className,
}: {
  lines: readonly TaskChatDiffLine[];
  truncated?: boolean;
  previewLines?: number;
  className?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? lines : lines.slice(0, previewLines);
  const hidden = lines.length - visible.length;
  return (
    <div
      className={cn("min-w-0 overflow-hidden rounded-sm border border-border bg-muted/30", className)}
      data-testid="task-chat-diff-view"
    >
      <div className="max-h-(--sz-edit-diff-max-h) overflow-auto">
        <table className="w-full border-collapse font-mono text-(length:--text-micro) leading-relaxed">
          <tbody>
            {visible.map((line, index) =>
              line.kind === "file" ? (
                <tr key={index} className="border-t border-border">
                  <td colSpan={2} className="truncate px-2 py-1 font-medium text-foreground">
                    {line.text}
                  </td>
                </tr>
              ) : line.kind === "hunk" ? (
                <tr key={index} className="bg-muted/60 text-muted-foreground">
                  <td colSpan={2} className="whitespace-pre px-2 py-0.5">
                    {hunkLabel(line.text)}
                  </td>
                </tr>
              ) : (
                <tr
                  key={index}
                  className={cn(
                    line.kind === "add" && "bg-(--diff-add-bg)",
                    line.kind === "remove" && "bg-(--diff-remove-bg)",
                  )}
                >
                  <td
                    aria-hidden
                    className={cn(
                      "w-4 select-none pl-2 align-top",
                      line.kind === "add" && "text-(--diff-add-fg)",
                      line.kind === "remove" && "text-(--diff-remove-fg)",
                      line.kind === "context" && "text-muted-foreground",
                    )}
                  >
                    {MARKER[line.kind]}
                  </td>
                  <td
                    className={cn(
                      "whitespace-pre pr-3 align-top",
                      line.kind === "context" ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    <span className="sr-only">{line.kind === "add" ? "Added: " : line.kind === "remove" ? "Removed: " : ""}</span>
                    {line.text || " "}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      {hidden > 0 || truncated ? (
        <div className="flex items-center gap-2 border-t border-border px-2 py-1 text-(length:--text-micro) text-muted-foreground">
          {hidden > 0 ? (
            <button
              type="button"
              className="text-foreground underline-offset-2 hover:underline"
              onClick={() => setShowAll(true)}
            >
              Show {hidden} more {hidden === 1 ? "line" : "lines"}
            </button>
          ) : null}
          {truncated && hidden === 0 ? <span>Diff shortened for display.</span> : null}
        </div>
      ) : null}
    </div>
  );
}
