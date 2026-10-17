import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SidePanelTabs, type SidePanelTabItem } from "@/components/side-panel";

const initialTabs: SidePanelTabItem[] = [
  { id: "properties", type: "properties", label: "Properties", closable: true },
  { id: "tasks", type: "subtasks", label: "Tasks", closable: true },
  { id: "notes", type: "issue-document", label: "ClipLab — Chat research notes", closable: true },
  { id: "plan", type: "issue-document", label: "Plan", closable: true },
  { id: "artifacts", type: "view", label: "Artifacts", closable: true },
  { id: "activity", type: "view", label: "Activity", closable: true },
  { id: "agent-runs", type: "view", label: "Agent runs", closable: true },
  { id: "related-tasks", type: "view", label: "Related tasks", closable: true },
  { id: "release-checklist", type: "issue-document", label: "Release checklist and handoff", closable: true },
];

function TaskSidePanelTabsPreview({ initialActive }: { initialActive: string }) {
  const [tabs, setTabs] = useState(initialTabs);
  const [activeTabId, setActiveTabId] = useState<string | null>(initialActive);
  const nextTabNumber = useRef(1);

  return (
    <div className="w-full border border-border bg-background p-4">
      <div className="flex h-(--side-panel-header-height) min-w-0 items-center border-b border-border">
        <SidePanelTabs
          tabs={tabs}
          activeTabId={activeTabId}
          onActiveTabChange={setActiveTabId}
          onCloseTab={(tabId) => {
            const remaining = tabs.filter((tab) => tab.id !== tabId);
            setTabs(remaining);
            if (activeTabId === tabId) setActiveTabId(remaining[0]?.id ?? null);
          }}
          onReorderTabs={(orderedIds) => {
            setTabs(orderedIds.flatMap((id) => tabs.find((tab) => tab.id === id) ?? []));
          }}
          onAddTab={() => {
            const number = nextTabNumber.current++;
            const id = `new-tab-${number}`;
            setTabs((current) => [...current, { id, type: "view", label: `New tab ${number}`, closable: true }]);
            setActiveTabId(id);
          }}
          appearance="streamlined-task"
        />
      </div>
    </div>
  );
}

const meta = {
  title: "Navigation/Task Side Panel Tabs",
  component: TaskSidePanelTabsPreview,
  parameters: {
    docs: {
      description: {
        component: "Resize the preview to see nine starting tabs across a wider pane. Use the plus button to add tabs. Hover the tabs and close buttons to inspect the active fill, content-sized width, clipped-label fade, and round close hover.",
      },
    },
  },
} satisfies Meta<typeof TaskSidePanelTabsPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShortTabActive: Story = { args: { initialActive: "tasks" } };
export const LongTabActive: Story = { args: { initialActive: "notes" } };
