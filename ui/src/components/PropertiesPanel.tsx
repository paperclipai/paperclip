import { X } from "lucide-react";
import { usePanel } from "../context/PanelContext";
import { useSidebar } from "../context/SidebarContext";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export function PropertiesPanel() {
  const { panelContent, panelVisible, setPanelVisible, closePanel } = usePanel();
  const { isMobile } = useSidebar();

  if (!panelContent) return null;

  if (isMobile) {
    return (
      <Sheet
        open={panelVisible}
        onOpenChange={(open) => {
          if (!open) {
            setPanelVisible(false);
            closePanel();
          }
        }}
      >
        <SheetContent side="right" showCloseButton={false}>
          <SheetHeader>
            <SheetTitle>Properties</SheetTitle>
          </SheetHeader>
          <ScrollArea className="flex-1 overflow-auto">
            <div className="px-4 pb-4">{panelContent}</div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      className="hidden md:flex border-l border-border bg-card flex-col shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-in-out h-full"
      style={{ width: panelVisible ? 320 : 0, opacity: panelVisible ? 1 : 0 }}
    >
      <div className="w-80 flex-1 flex flex-col min-w-[320px] min-h-0">
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
