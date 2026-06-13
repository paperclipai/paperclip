import { X } from "lucide-react";
import { useCallback, useRef } from "react";
import { usePanel } from "../context/PanelContext";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

const MIN_PANEL_WIDTH = 240;
const MAX_PANEL_WIDTH = 600;

function clampWidth(width: number): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width));
}

export function PropertiesPanel() {
  const { panelContent, panelVisible, panelWidth, setPanelVisible, setPanelWidth } = usePanel();
  const asideRef = useRef<HTMLElement | null>(null);

  if (!panelContent) return null;

  const handleResizeStart = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!panelVisible) return;
    event.preventDefault();

    const aside = asideRef.current;
    if (!aside) return;

    const startX = event.clientX;
    const startWidth = aside.getBoundingClientRect().width;
    const previousTransition = aside.style.transition;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;

    aside.style.transition = "none";
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const updateWidth = (clientX: number) => {
      const delta = startX - clientX;
      const nextWidth = clampWidth(startWidth + delta);
      aside.style.width = `${nextWidth}px`;
      return nextWidth;
    };

    let finalWidth = startWidth;

    const onMouseMove = (moveEvent: MouseEvent) => {
      finalWidth = updateWidth(moveEvent.clientX);
    };

    const onMouseUp = () => {
      aside.style.transition = previousTransition;
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      setPanelWidth(finalWidth);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [panelVisible, setPanelWidth]);

  return (
    <aside
      ref={asideRef}
      className="relative hidden md:flex border-l border-border bg-card flex-col shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-in-out h-full"
      style={{ width: panelVisible ? panelWidth : 0, opacity: panelVisible ? 1 : 0 }}
    >
      <div
        className="absolute inset-y-0 left-0 w-1 cursor-col-resize hover:bg-border"
        onMouseDown={handleResizeStart}
        aria-hidden="true"
      />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <span className="text-sm font-medium">Properties</span>
          <Button variant="ghost" size="icon-xs" onClick={() => setPanelVisible(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
        <ScrollArea className="flex-1">
          <div className="p-4">{panelContent}</div>
        </ScrollArea>
      </div>
    </aside>
  );
}
