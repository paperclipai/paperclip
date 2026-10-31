import { useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SidePanelTabs, type SidePanelTabItem } from "@/components/side-panel";

const initialTabs: SidePanelTabItem[] = [
  { id: "properties", type: "properties", label: "Properties", closable: true },
  { id: "subtasks", type: "subtasks", label: "Subtasks", closable: true },
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
  id: "navigation-task-side-panel-tabs",
  title: "Oversight and operation/Navigation, profile, and announcements/Product/Task side panel tabs",
  component: TaskSidePanelTabsPreview,
  parameters: {
    docs: {
      description: {
        component: "Resize the preview to see nine starting tabs share the available width equally. All tabs use 100px when their labels fit, or 125px when any label needs more room, then shrink together as the pane narrows. Close the longer tabs to inspect compact sizing. Use the plus button to add tabs. Hover the tabs and close buttons to inspect the active fill, clipped-label fade, and round close hover.",
      },
    },
    paperclip: {
      capabilities: ["navigation-preferences/navigation"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Uses the shipped task side panel tab component with local tab state. Covers desktop tab sizing, selection, reordering, and closing; task data and persistence are outside this preview.",
    },
  },
} satisfies Meta<typeof TaskSidePanelTabsPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ShortTabActive: Story = { args: { initialActive: "subtasks" } };
export const LongTabActive: Story = { args: { initialActive: "notes" } };
