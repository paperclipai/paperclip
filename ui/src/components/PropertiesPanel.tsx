import { usePanel } from "../context/PanelContext";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useT } from "../i18n";

export function PropertiesPanel() {
  const { t } = useT();
  const { panelContent, panelHeaderActions, panelVisible } = usePanel();

  if (!panelContent) return null;

  return (
    <aside
      className="hidden md:flex border-l border-border bg-card flex-col shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-in-out"
      style={{ width: panelVisible ? 320 : 0, opacity: panelVisible ? 1 : 0 }}
    >
      <div className="w-80 flex-1 flex flex-col min-w-[320px]">
        {panelHeaderActions ? (
          <div className="flex items-center justify-end px-3 py-2 border-b border-border gap-0.5">
            {panelHeaderActions}
          </div>
        ) : (
          <div className="flex items-center px-4 py-2 border-b border-border">
            <span className="text-sm font-medium">{t("propertiesPanel.title")}</span>
          </div>
        )}
        <ScrollArea className="flex-1">
          <div className="p-4">{panelContent}</div>
        </ScrollArea>
      </div>
    </aside>
  );
}
