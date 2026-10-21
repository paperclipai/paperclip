import { CommandPalette } from "@/components/CommandPalette";
import { DesignPageShell } from "@/components/DesignPageShell";
import { DesignSidebar } from "@/components/DesignSidebar";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  SidePanelLauncher, SidePanelTabs, SidePanelToggleButton, SidePanelWindowControls,
  useSidePanelTabs, type SidePanelTabRecord,
} from "@/components/side-panel";
import { useDialogActions } from "@/context/DialogContext";
import { DesignProposalAccess } from "./DesignProposalAccess";
import { recentTasks } from "./task-page-data";

export type AppShellPreviewProps = {
  rightSidebar: boolean;
  overflowingContent: boolean;
};

const availableTabs: SidePanelTabRecord<null>[] = ["Properties", "Tasks", "Plan", "Artifacts"].map(label => ({
  id: `app-shell-${label.toLowerCase()}`, type: "placeholder", label, closable: true, payload: null,
}));

function ContentBlocks({ count, label }: { count: number; label: string }) {
  return <div className="space-y-4">
    {Array.from({ length: count }, (_, index) => <Card key={index} elevation="low">
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <h3 className="font-semibold text-foreground">{label} {index + 1}</h3>
        <p>Placeholder content supplied by the page.</p>
      </CardContent>
    </Card>)}
  </div>;
}

function AppShellContent({ rightSidebar, overflowingContent }: AppShellPreviewProps) {
  const { openNewIssue } = useDialogActions();
  const [panelOpen, setPanelOpen] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const panelToggleRef = useRef<HTMLSpanElement>(null);
  const controller = useSidePanelTabs({ initialState: { tabs: availableTabs, activeTabId: availableTabs[0].id } });
  const activeTab = controller.tabs.find(tab => tab.id === controller.activeTabId);
  const launcherSections = [{
    id: "panels", label: "Panels",
    items: availableTabs.map(tab => ({ id: tab.id, label: tab.label, alreadyOpen: controller.tabs.some(openTab => openTab.id === tab.id) })),
  }];
  const openTab = ({ id }: { id: string }) => {
    const tab = availableTabs.find(candidate => candidate.id === id);
    if (tab) controller.openTab(tab);
  };
  const closePanel = () => {
    setPanelOpen(false);
    setMaximized(false);
    requestAnimationFrame(() => panelToggleRef.current?.querySelector("button")?.focus());
  };
  const variant = rightSidebar ? "three-panes" : "two-panes";
  return <>
    <DesignPageShell
      title="App shell"
      sidebarStorageKey={`paperclip.design-proposal.app-shell.${variant}.width`}
      sidebar={<DesignSidebar recentTasks={recentTasks.map(item => item.issue)} onNewTask={() => openNewIssue()} />}
      headerActions={rightSidebar && <span ref={panelToggleRef}><SidePanelToggleButton open={panelOpen} highlightWhenOpen={false} onToggle={() => panelOpen ? closePanel() : setPanelOpen(true)} /></span>}
      rightSidebarTitle="Right sidebar"
      rightSidebarMaximized={maximized}
      rightSidebarHeader={<SidePanelTabs
        tabs={controller.tabs}
        activeTabId={controller.activeTabId}
        onActiveTabChange={controller.selectTab}
        onCloseTab={controller.closeTab}
        onReorderTabs={controller.reorderTabs}
        appearance="streamlined-task"
        addControl={<SidePanelLauncher
          sections={launcherSections} onSelect={openTab} presentation="popover"
          trigger={<Button type="button" variant="ghost" size="icon-sm"
            className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:text-foreground h-(--side-panel-tab-height) w-(--side-panel-tab-height) rounded-md"
            aria-label="Open a new tab"><Plus aria-hidden /></Button>}
        />}
      />}
      rightSidebarControls={<SidePanelWindowControls maximized={maximized} onMaximizedChange={setMaximized} onToggle={closePanel} closeControl="close" />}
      rightSidebar={rightSidebar && panelOpen ? activeTab ? <div
        role="tabpanel" id={`side-panel-content-${activeTab.id}`} aria-labelledby={`side-panel-tab-${activeTab.id}`}
        className="space-y-4" tabIndex={0}
      >
        <p className="text-sm text-muted-foreground">{activeTab.label}: details, context, or tools supplied by the page. This pane scrolls independently.</p>
        <ContentBlocks count={overflowingContent ? 12 : 2} label="Supporting content" />
      </div> : <SidePanelLauncher sections={launcherSections} onSelect={openTab} /> : undefined}
    >
      <section className="max-w-xl space-y-3 text-sm text-muted-foreground">
        <h2 className="text-lg font-semibold text-foreground">Main content</h2>
        <p>{rightSidebar ? "Left sidebar, main content, and right sidebar." : "Left sidebar and main content."} The same shell is used by the Tasks page.</p>
        <p>Resize a sidebar by dragging its divider or using the arrow keys on the focused divider. Double-click a divider to smoothly restore its default width. The main pane fills the remaining space; pane headers stay fixed while their content scrolls.</p>
      </section>
      <ContentBlocks count={overflowingContent ? 20 : 3} label="Page content" />
    </DesignPageShell>
    <NewIssueDialog />
    <CommandPalette />
  </>;
}

export function AppShellPreview(props: AppShellPreviewProps) {
  return <DesignProposalAccess><AppShellContent {...props} /></DesignProposalAccess>;
}
import { useRef, useState } from "react";
import { Plus } from "lucide-react";
