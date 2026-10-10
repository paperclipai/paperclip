import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { userEvent, within } from "storybook/test";
import { Box, FileText, Lightbulb, Plus, SlidersHorizontal, X } from "lucide-react";
import { SidePanelLauncher, SidePanelMobileTabs, useSidePanelTabs, type SidePanelTabRecord } from "@/components/side-panel";
import { Button } from "@/components/ui/button";

const basicTabs: SidePanelTabRecord[] = [
  { id: "properties", type: "view", label: "Properties", payload: {}, contentMode: "padded" },
  { id: "plan", type: "document", label: "Plan", payload: {}, contentMode: "prose" },
  { id: "artifacts", type: "view", label: "Artifacts", payload: {}, contentMode: "padded" },
];
const longTitle = "Bookmarked post formats and 14 model-harness tweets";
const documentTabs = [
  ...basicTabs,
  { id: "research", type: "document", label: longTitle, payload: {}, contentMode: "prose" as const },
  { id: "qa", type: "document", label: "Release verification and mobile accessibility evidence", payload: {}, contentMode: "prose" as const },
];

function Prototype({ initialTabs = basicTabs, activeTabId = "plan" }: { initialTabs?: SidePanelTabRecord[]; activeTabId?: string }) {
  const controller = useSidePanelTabs({ initialState: { tabs: initialTabs, activeTabId } });
  const [closed, setClosed] = useState(false);
  const active = controller.tabs.find((tab) => tab.id === controller.activeTabId);
  if (closed) return <div className="p-6"><Button onClick={() => setClosed(false)}>Reopen task panel</Button></div>;
  return (
    <div className="mx-auto flex h-dvh w-full max-w-sm flex-col bg-background text-foreground">
      <div className="flex h-(--side-panel-header-height) shrink-0 items-center gap-1 border-b px-2">
        <SidePanelMobileTabs
          tabs={controller.tabs.map((tab) => ({ ...tab, icon: tab.id === "properties" ? <SlidersHorizontal /> : tab.id === "plan" ? <Lightbulb /> : tab.id === "artifacts" ? <Box /> : <FileText /> }))}
          activeTabId={controller.activeTabId}
          onActiveTabChange={controller.selectTab}
          onCloseTab={controller.closeTab}
          addControl={<SidePanelLauncher presentation="popover" sections={[{ id: "documents", label: "Task tabs", items: documentTabs.map((tab) => ({ id: tab.id, label: tab.label, alreadyOpen: controller.tabs.some((open) => open.id === tab.id) })) }]} onSelect={(item) => controller.openTab(documentTabs.find((tab) => tab.id === item.id)!)} trigger={<Button variant="ghost" size="icon" className="size-(--sz-44px) shrink-0" aria-label="Open a new tab"><Plus aria-hidden /></Button>} />}
        />
        <Button variant="ghost" size="icon" className="size-(--sz-44px) shrink-0" aria-label="Close side panel" onClick={() => setClosed(true)}><X aria-hidden /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-6" role={active ? "tabpanel" : undefined} aria-labelledby={active ? `side-panel-tab-${active.id}` : undefined}>
        {active ? <>
          <h1 className="text-xl font-semibold">{active.label}</h1>
          <p className="mt-2 text-xs text-muted-foreground">Revision 4 · Updated today</p>
          <h2 className="mt-8 text-lg font-semibold">A readable mobile task panel</h2>
          <p className="mt-3 text-sm leading-relaxed">Tap the title to see all open tabs. Full document names wrap in the vertical list. The check marks your current tab, and each row has its own close button.</p>
          <p className="mt-4 text-sm leading-relaxed">The top-right X returns to the task feed. Use + to open another task document. Closing an inactive tab keeps this document selected.</p>
        </> : <p className="text-sm text-muted-foreground">All tabs are closed. Use + to open a tab.</p>}
      </div>
    </div>
  );
}

const meta = {
  title: "Prototypes/Task detail/Mobile tabs",
  parameters: {
    layout: "fullscreen",
    docs: { description: { component: "A task toolbar with a vertical open-tab overview. The current document stays readable; titles wrap in the overview, selection is explicit, close actions stay visible, and controls have 44px touch targets. Inspired by Apple’s toolbar and safe-area guidance: https://developer.apple.com/design/human-interface-guidelines/toolbars and https://developer.apple.com/design/human-interface-guidelines/layout." } },
  },
  globals: { viewport: { value: "mobile", isRotated: false }, theme: "light" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const ThreeTabs: Story = { render: () => <Prototype /> };
export const LongDocumentTitles: Story = {
  render: () => <Prototype initialTabs={documentTabs} activeTabId="research" />,
  play: async () => { await userEvent.click(await within(document.body).findByRole("button", { name: "Switch tabs, 5 open" })); },
};
export const ManyTabs: Story = {
  render: () => <Prototype initialTabs={[...documentTabs, ...Array.from({ length: 10 }, (_, index) => ({ id: `output-${index}`, type: "document", label: `Research output ${index + 1}: decisions, evidence, and next steps`, payload: {} }))]} activeTabId="research" />,
  play: async () => { await userEvent.click(await within(document.body).findByRole("button", { name: "Switch tabs, 15 open" })); },
};
export const LastTab: Story = { render: () => <Prototype initialTabs={[basicTabs[1]!]} /> };
