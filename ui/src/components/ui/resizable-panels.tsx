import { Group, Panel, Separator } from "react-resizable-panels";
import type { GroupProps, PanelProps, SeparatorProps } from "react-resizable-panels";
import { cn } from "@/lib/utils";

/**
 * Thin design-system wrapper over `react-resizable-panels` (PAP-12962 D2 — the
 * only net-new shared primitive Skill Studio adds). Re-exports the library's
 * Group / Panel / Separator with Paperclip token styling and a comfortable
 * (≥8px) resize hit-slop so a split view can be dropped in anywhere.
 *
 * Sizes accept the library's units: bare numbers/`"37.5%"` are percentages,
 * `"280px"` is a pixel floor (used here for the min-width contract).
 */

export function ResizablePanelGroup({ className, ...props }: GroupProps) {
  return (
    <Group
      className={cn("flex h-full w-full data-[orientation=vertical]:flex-col", className)}
      // Keep hit targets generous on both coarse (touch) and fine (mouse) input.
      resizeTargetMinimumSize={{ coarse: 24, fine: 12 }}
      {...props}
    />
  );
}
ResizablePanelGroup.displayName = "ResizablePanelGroup";

export function ResizablePanel({ className, ...props }: PanelProps) {
  return <Panel className={cn("h-full min-h-0 overflow-hidden", className)} {...props} />;
}
ResizablePanel.displayName = "ResizablePanel";

/**
 * A 1px visible divider centred inside a wider transparent hit target
 * (Fitts's Law). Resize is instantaneous — the only transition is the hover
 * colour, which is harmless under `prefers-reduced-motion`.
 */
export function ResizableHandle({ className, orientation = "horizontal", ...props }: SeparatorProps & {
  orientation?: "horizontal" | "vertical";
}) {
  const vertical = orientation === "vertical";
  return (
    <Separator
      className={cn(
        "group relative flex items-center justify-center bg-transparent outline-none",
        "focus-visible:ring-1 focus-visible:ring-ring",
        vertical ? "h-2 w-full cursor-row-resize" : "w-2 h-full cursor-col-resize",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "bg-border transition-colors group-hover:bg-ring group-data-[dragging]:bg-ring",
          vertical ? "h-px w-full" : "w-px h-full",
        )}
      />
    </Separator>
  );
}
ResizableHandle.displayName = "ResizableHandle";
