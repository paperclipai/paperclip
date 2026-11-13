import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidePanelFrame, SidePanelWindowControls } from "@/components/side-panel/SidePanelFrame";
import { SidePanelTabs } from "@/components/side-panel/SidePanelTabs";
import type { SidePanelTabItem } from "@/components/side-panel/types";
import type { DirectionKit, LabArtifact } from "../kit";
import { Slot } from "./Slot";

/**
 * The task's right-hand pane, open on the Artifacts tab.
 *
 * The frame, the tab strip and the window controls are the shipped components
 * (they are presentational); only the host around them is mirrored:
 * PropertiesPanel.tsx:371-441 for the aside and TaskSidePanel.tsx:562-690,
 * 814-826 for the tab set, the "+" launcher trigger and the body padding.
 */

// PropertiesPanel.tsx:85
export const TASK_DETAIL_PANE_WIDTH = 434;

// TaskSidePanel.tsx:280,562 — every tab is closable, Properties included.
const TABS: SidePanelTabItem[] = [
  { id: "properties", type: "properties", label: "Properties", closable: true },
  { id: "subtasks", type: "subtasks", label: "Tasks", closable: true },
  { id: "artifacts", type: "artifacts", label: "Artifacts", closable: true },
];

const noop = () => {};

export function PanelFrame({ kit, artifacts, width = TASK_DETAIL_PANE_WIDTH }: { kit: DirectionKit; artifacts: LabArtifact[]; width?: number }) {
  return (
    <aside className="flex bg-card flex-col border-l border-border relative shrink-0" style={{ width }}>
      <SidePanelFrame
        presentation="docked"
        contentMode="full-bleed"
        headerSize="task-detail"
        className="flex-1 border-l-0"
        header={
          <div className="flex min-w-0 flex-1 items-center self-stretch">
            <SidePanelTabs
              tabs={TABS}
              activeTabId="artifacts"
              onActiveTabChange={noop}
              onCloseTab={noop}
              appearance="streamlined-task"
              addControl={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground h-(--side-panel-tab-height) w-(--side-panel-tab-height) rounded-md"
                  aria-label="Open a new tab"
                >
                  <Plus aria-hidden />
                </Button>
              }
            />
          </div>
        }
        trailingControls={<SidePanelWindowControls maximized={false} onMaximizedChange={noop} onToggle={noop} closeControl="close" />}
      >
        {/* TaskSidePanel.tsx:814-826, "padded" mode, without the scroll: the lab's frames grow instead. */}
        <div className="min-h-0 flex-1 p-4">
          <Slot kit={kit}>
            <kit.PanelBody artifacts={artifacts} />
          </Slot>
        </div>
      </SidePanelFrame>
    </aside>
  );
}
