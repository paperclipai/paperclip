import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PropertiesPanel } from "@/components/PropertiesPanel";
import { TaskSidePanel } from "@/components/task-side-panel";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Button } from "@/components/ui/button";
import { usePanel } from "@/context/PanelContext";
import { IssueDetailLoadingState } from "@/pages/IssueDetail";
import { storybookIssues } from "../../fixtures/paperclipData";

const issue = storybookIssues[0]!;
const noUpdate = () => {};

function LoadingTransition({ sidebar, initiallyHidden, sidebarDelay, contentDelay }: {
  sidebar: boolean;
  initiallyHidden: boolean;
  sidebarDelay: number;
  contentDelay: number;
}) {
  const { openPanel, closePanel, setPanelVisible } = usePanel();
  const [replay, setReplay] = useState(0);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    closePanel();
    setLoaded(false);
    setPanelVisible(!initiallyHidden);
    const panelTimer = sidebar ? window.setTimeout(() => {
      openPanel(
        <TaskSidePanel
          issue={issue}
          accountScope="storybook-loading"
          fileTabsEnabled={false}
          streamlinedTabs
          showSubtasksTab
          onUpdate={noUpdate}
        />,
        { contentMode: "full-bleed" },
      );
    }, sidebarDelay) : undefined;
    const contentTimer = window.setTimeout(() => setLoaded(true), contentDelay);
    return () => {
      window.clearTimeout(panelTimer);
      window.clearTimeout(contentTimer);
      closePanel();
    };
  }, [replay, sidebar, initiallyHidden, sidebarDelay, contentDelay, openPanel, closePanel, setPanelVisible]);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex items-center gap-3 border-b border-border px-6 py-3">
        <Button variant="outline" size="sm" onClick={() => setReplay((current) => current + 1)}>Replay cold load</Button>
        <Button variant="ghost" size="sm" onClick={() => setPanelVisible(true)}>Show sidebar</Button>
        <span className="text-xs text-muted-foreground">Delayed fixture data · uses the production skeleton and sidebar host</span>
      </div>
      <div className="streamlined-task-detail-surface flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto p-6">
          {loaded ? (
            <div className="mx-auto max-w-(--tc-shell-max-w) space-y-6">
              <span className="text-sm text-muted-foreground">{issue.identifier}</span>
              <h2 className="text-xl font-bold">{issue.title}</h2>
              <MarkdownBody>{issue.description ?? "The task is ready. The sidebar and thread share the same layout transition."}</MarkdownBody>
            </div>
          ) : <IssueDetailLoadingState headerSeed={null} />}
        </main>
        <PropertiesPanel taskDetailLayout />
      </div>
    </div>
  );
}

const meta = {
  id: "tasks-sidebar-loading",
  title: "Tasks and conversations/Task creation and lifecycle/Sidebar loading",
  component: LoadingTransition,
  parameters: {
    layout: "fullscreen",
    paperclip: {
      capabilities: ["tasks/properties", "tasks/discussion"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production PropertiesPanel, TaskSidePanel, and IssueDetailLoadingState in a local flex shell. Replay late sidebar discovery, content-first loading, absent sidebars, and a saved hidden preference. Timers simulate data arrival; resolved thread content is a fixture, not the full task page. Browser reduced-motion preferences apply.",
    },
  },
  args: { sidebar: true, initiallyHidden: false, sidebarDelay: 1200, contentDelay: 2400 },
  argTypes: {
    sidebarDelay: { control: { type: "range", min: 0, max: 5000, step: 100 } },
    contentDelay: { control: { type: "range", min: 0, max: 5000, step: 100 } },
  },
} satisfies Meta<typeof LoadingTransition>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SidebarDuringSkeleton: Story = {};
export const SidebarAfterContent: Story = { args: { sidebarDelay: 2400, contentDelay: 800 } };
export const WithoutSidebar: Story = { args: { sidebar: false } };
export const HiddenSidebar: Story = { args: { initiallyHidden: true } };
