import { X } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

export function PropertiesPanel() {
  const { panelContent, panelVisible, setPanelVisible } = usePanel();

  if (!panelContent) return null;

  return (
    <aside
      className="hidden shrink-0 overflow-hidden border-l border-[color:var(--surface-outline)] bg-transparent transition-[width,opacity] duration-200 ease-in-out md:flex"
      style={{ width: panelVisible ? 320 : 0, opacity: panelVisible ? 1 : 0 }}
    >
      <div className="paperclip-panel flex min-w-[320px] w-80 flex-1 flex-col rounded-none border-0 border-l border-[color:var(--surface-outline)]">
        <div className="flex items-center justify-between border-b border-[color:var(--surface-outline)] px-4 py-3">
          <div>
            <div className="paperclip-kicker mb-1">Context</div>
            <span className="text-sm font-semibold">Properties</span>
          </div>
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
