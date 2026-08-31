import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  Activity,
  AlertTriangle,
  Box,
  CheckCircle2,
  FileCode2,
  FileText,
  FolderOpen,
  History,
  Info,
  Lightbulb,
  Loader2,
  Plus,
  Settings,
  SlidersHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SidePanelFrame,
  SidePanelLauncher,
  SidePanelTab,
  SidePanelTabs,
  SidePanelToggleButton,
  SidePanelWindowControls,
  useSidePanelTabs,
  type SidePanelContentMode,
  type SidePanelLauncherItem,
  type SidePanelLauncherSection,
  type SidePanelPresentation,
  type SidePanelTabItem,
  type SidePanelTabRecord,
} from "@/components/side-panel";

const interactionLog = {
  select: fn(),
  add: fn(),
  close: fn(),
  reorder: fn(),
  hide: fn(),
  maximize: fn(),
  restore: fn(),
};

type DemoPayload = { body: string };

const DEMO_TABS: SidePanelTabRecord<DemoPayload>[] = [
  { id: "properties", type: "properties", label: "Properties", payload: { body: "Structured metadata and controls." } },
  { id: "document:plan", type: "plan", label: "Plan", payload: { body: "A readable plan document with annotations." } },
  { id: "artifacts", type: "artifacts", label: "Artifacts", payload: { body: "Work products, documents, and generated files." } },
  { id: "document:review", type: "document", label: "2026-08-23-paperclip-runner-stress-campaign.md", payload: { body: "A deliberately long document title demonstrates truncation." } },
  { id: "files", type: "files", label: "Files", payload: { body: "Browse the active workspace." }, contentMode: "full-bleed" },
  { id: "file:driver", type: "file", label: "codex-driver.md", payload: { body: "Workspace file preview." }, contentMode: "full-bleed" },
];

function iconFor(type: string): ReactNode {
  if (type === "properties") return <SlidersHorizontal />;
  if (type === "plan") return <Lightbulb />;
  if (type === "artifacts") return <Box />;
  if (type === "files") return <FolderOpen />;
  if (type === "file") return <FileCode2 />;
  if (type === "activity") return <Activity />;
  if (type === "history") return <History />;
  if (type === "settings") return <Settings />;
  if (type === "info") return <Info />;
  return <FileText />;
}

function visualTabs(tabs: SidePanelTabRecord<DemoPayload>[]): SidePanelTabItem[] {
  return tabs.map((tab) => ({
    id: tab.id,
    type: tab.type,
    label: tab.label,
    ariaLabel: tab.ariaLabel,
    closable: tab.closable ?? true,
    contentMode: tab.contentMode,
    icon: iconFor(tab.type),
  }));
}

const LAUNCHER_SECTIONS: SidePanelLauncherSection[] = [
  {
    id: "views",
    label: "Open",
    items: [
      { id: "properties", label: "Properties", icon: <SlidersHorizontal /> },
      { id: "artifacts", label: "Artifacts", icon: <Box /> },
      { id: "files", label: "Files", icon: <FolderOpen />, shortcut: "G F" },
    ],
  },
  {
    id: "suggested",
    label: "Suggested",
    items: [
      { id: "document:plan", label: "Plan", description: "Task document", icon: <Lightbulb /> },
      { id: "document:review", label: "2026-08-23-paperclip-runner-stress-campaign.md", description: "Updated moments ago", icon: <FileText /> },
      { id: "file:driver", label: "codex-driver.md", description: "ui/src/components", icon: <FileCode2 /> },
    ],
  },
];

interface SidePanelStoryArgs {
  width: number;
  presentation: SidePanelPresentation;
  contentMode: SidePanelContentMode;
  maximized: boolean;
  open: boolean;
  initialTabCount: number;
  initialActiveTabId: string;
  empty: boolean;
  launcherOpen: boolean;
  dark: boolean;
}

function DemoContent({ tab }: { tab: SidePanelTabRecord<DemoPayload> }) {
  if (tab.contentMode === "full-bleed") {
    return (
      <div className="flex h-full min-h-72 bg-muted/30 p-3">
        <div className="w-2/5 overflow-hidden rounded-lg border border-border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground">Workspace</div>
          <div className="mt-3 space-y-1 text-sm">
            <div className="truncate rounded-md bg-accent px-2 py-1">ui/src/components</div>
            <div className="truncate px-2 py-1">server/src/routes</div>
            <div className="truncate px-2 py-1">packages/shared</div>
          </div>
        </div>
        <div className="min-w-0 flex-1 p-4 font-mono text-xs leading-6 text-muted-foreground">
          {tab.payload.body}
          <br />
          export function PortableSidePanel() &#123;
          <br />&nbsp;&nbsp;return &quot;content&quot;;
          <br />&#125;
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{tab.type}</div>
        <h2 className="mt-1 text-lg font-semibold">{tab.label}</h2>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">{tab.payload.body}</p>
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="rounded-lg border border-border p-3 text-sm">
          Portable content row {index + 1}
        </div>
      ))}
    </div>
  );
}

function SidePanelStoryHarness(args: SidePanelStoryArgs) {
  const initialTabs = args.empty ? [] : DEMO_TABS.slice(0, args.initialTabCount);
  const controller = useSidePanelTabs<DemoPayload>({
    initialState: {
      tabs: initialTabs,
      activeTabId: initialTabs.some((tab) => tab.id === args.initialActiveTabId)
        ? args.initialActiveTabId
        : initialTabs[0]?.id ?? null,
    },
  });
  const [panelOpen, setPanelOpen] = useState(args.open);
  const [maximized, setMaximized] = useState(args.maximized);
  const [launcherOpen, setLauncherOpen] = useState(args.launcherOpen);
  const frameRootRef = useRef<HTMLDivElement>(null);
  const activeTab = controller.tabs.find((tab) => tab.id === controller.activeTabId) ?? null;
  const tabs = useMemo(() => visualTabs(controller.tabs), [controller.tabs]);
  const launcherSections = useMemo(
    () => LAUNCHER_SECTIONS.map((section) => ({
      ...section,
      items: section.items.map((item) => ({
        ...item,
        alreadyOpen: controller.tabs.some((tab) => tab.id === item.id),
      })),
    })),
    [controller.tabs],
  );

  useEffect(() => {
    if (activeTab) return;
    window.requestAnimationFrame(() => {
      frameRootRef.current
        ?.querySelector<HTMLInputElement>('input[aria-label="Search tabs and resources…"]')
        ?.focus();
    });
  }, [activeTab]);

  function openLauncherItem(item: SidePanelLauncherItem) {
    interactionLog.add(item.id);
    const tab = DEMO_TABS.find((candidate) => candidate.id === item.id);
    if (tab) controller.openTab(tab);
  }

  const launcher = (
    <SidePanelLauncher
      sections={launcherSections}
      onSelect={openLauncherItem}
      presentation="popover"
      open={launcherOpen}
      onOpenChange={setLauncherOpen}
      trigger={(
        <Button type="button" variant="ghost" size="icon-sm" className="h-(--side-panel-tab-height) w-(--side-panel-tab-height) shrink-0 rounded-xl text-muted-foreground hover:text-foreground focus-visible:text-foreground" aria-label="Open a new tab">
          <Plus aria-hidden />
        </Button>
      )}
    />
  );

  const frame = (
    <div ref={frameRootRef} className="flex h-screen min-h-96 justify-end bg-background text-foreground">
      <div className="min-w-0 flex-1 p-8">
        <div className="flex items-center justify-between border-b border-border pb-4">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Host application</div>
            <h1 className="mt-1 text-xl font-semibold">Portable side-panel preview</h1>
          </div>
          {panelOpen ? null : (
            <SidePanelToggleButton
              open={false}
              onToggle={() => {
                interactionLog.hide(false);
                setPanelOpen(true);
              }}
              shortcut="]"
            />
          )}
        </div>
      </div>
      <div
        className="shrink-0"
        style={{ width: maximized ? "min(72rem, 100vw)" : args.width }}
      >
        <SidePanelFrame
          presentation={args.presentation}
          open={panelOpen}
          maximized={maximized}
          contentMode={activeTab?.contentMode ?? args.contentMode}
          header={(
            <SidePanelTabs
              tabs={tabs}
              activeTabId={controller.activeTabId}
              onActiveTabChange={(tabId) => {
                interactionLog.select(tabId);
                controller.selectTab(tabId);
              }}
              onCloseTab={(tabId) => {
                interactionLog.close(tabId);
                controller.closeTab(tabId);
              }}
              onReorderTabs={(tabIds) => {
                interactionLog.reorder(tabIds);
                controller.reorderTabs(tabIds);
              }}
              addControl={launcher}
            />
          )}
          trailingControls={args.presentation === "sheet" ? (
            <SidePanelToggleButton open onToggle={() => setPanelOpen(false)} />
          ) : (
            <SidePanelWindowControls
              maximized={maximized}
              onMaximizedChange={(next) => {
                interactionLog[next ? "maximize" : "restore"]();
                setMaximized(next);
              }}
              onToggle={() => {
                interactionLog.hide();
                setPanelOpen(false);
              }}
            />
          )}
        >
          {activeTab ? (
            <DemoContent tab={activeTab} />
          ) : (
            <SidePanelLauncher sections={launcherSections} onSelect={openLauncherItem} />
          )}
        </SidePanelFrame>
      </div>
    </div>
  );

  return <div className={args.dark ? "dark" : undefined}>{frame}</div>;
}

function TaskPagePersistentLauncherStory() {
  const [panelOpen, setPanelOpen] = useState(false);

  return (
    <div className="flex h-screen min-h-0 overflow-hidden bg-background text-foreground">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 md:px-6">
          <span className="shrink-0 text-sm text-muted-foreground">Tasks</span>
          <span aria-hidden className="text-muted-foreground">›</span>
          <span className="shrink-0 font-mono text-sm text-muted-foreground">PAP-16679</span>
          <span className="min-w-0 flex-1 truncate text-sm">
            Keep the task side-panel launcher available while scrolling
          </span>
          {panelOpen ? null : (
            <span data-testid="task-page-panel-launcher">
              <SidePanelToggleButton
                open={false}
                onToggle={() => setPanelOpen(true)}
                shortcut="]"
              />
            </span>
          )}
        </header>

        <main
          data-testid="scrollable-task-page"
          className="min-h-0 flex-1 overflow-y-auto px-5 py-8 md:px-12"
        >
          <div className="mx-auto max-w-3xl space-y-7">
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm font-medium">
                <span className="flex size-6 items-center justify-center rounded-full bg-muted text-(length:--text-nano)">CO</span>
                Codex
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                This full task frame demonstrates that the launcher belongs to the persistent
                task row rather than the scrollable conversation header.
              </p>
            </div>
            {Array.from({ length: 18 }, (_, index) => (
              <section key={index} className="space-y-2 py-2">
                <div className="text-sm font-medium">Task activity {index + 1}</div>
                <p className="text-sm leading-6 text-muted-foreground">
                  Runner commentary, workspace activity, and historical receipts can make the
                  thread much taller than the viewport. Scroll here and the task row remains in
                  place with its panel launcher.
                </p>
              </section>
            ))}
          </div>
        </main>
      </div>

      {panelOpen ? (
        <div className="w-[380px] shrink-0">
          <SidePanelFrame
            open
            presentation="docked"
            contentMode="padded"
            header={<div className="px-2 text-sm font-medium">Task properties</div>}
            trailingControls={(
              <SidePanelToggleButton open onToggle={() => setPanelOpen(false)} />
            )}
          >
            <div className="space-y-4">
              <h2 className="text-base font-semibold">Properties</h2>
              <p className="text-sm text-muted-foreground">
                The top-row launcher is hidden while this panel is open. Use the panel control to
                close it and restore the launcher.
              </p>
            </div>
          </SidePanelFrame>
        </div>
      ) : null}
    </div>
  );
}

const meta = {
  title: "Navigation/Side Panel",
  component: SidePanelStoryHarness,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Portable, controlled Codex-style side-panel components. SidePanelFrame owns presentation and content layout; SidePanelTabs owns focus, close recovery, overflow, and reorder mechanics; SidePanelLauncher renders caller-provided resource sections in popover or empty-panel form. Hosts own serializable tab payloads, persistence, data fetching, routing, and content registries. Persist descriptors rather than React nodes, restore validated state in the adapter, and project domain icons/status into SidePanelTabItem. A new page registers its own tab types by defining a payload union, mapping it to SidePanelTabRecord values, and switching on that payload only in the page adapter. Arrow/Home/End navigation, keyboard reorder announcements, labels, and close focus recovery remain in the shared layer.",
      },
    },
  },
  args: {
    width: 380,
    presentation: "docked",
    contentMode: "padded",
    maximized: false,
    open: true,
    initialTabCount: 3,
    initialActiveTabId: "document:plan",
    empty: false,
    launcherOpen: false,
    dark: false,
  },
  argTypes: {
    width: { control: { type: "range", min: 260, max: 760, step: 20 } },
    presentation: { control: "inline-radio", options: ["docked", "sheet", "embedded"] },
    contentMode: { control: "inline-radio", options: ["padded", "prose", "full-bleed"] },
    initialTabCount: { control: { type: "range", min: 0, max: DEMO_TABS.length, step: 1 } },
    initialActiveTabId: { control: "select", options: DEMO_TABS.map((tab) => tab.id) },
  },
} satisfies Meta<typeof SidePanelStoryHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultDocked: Story = {};

export const MixedResourceTabs: Story = {
  args: { width: 680, initialTabCount: 6, initialActiveTabId: "document:review" },
};

export const NarrowOverflow: Story = {
  args: { width: 260, initialTabCount: 6, initialActiveTabId: "file:driver" },
};

export const EmptyPanel: Story = {
  args: { empty: true, initialTabCount: 0 },
};

export const LauncherOpen: Story = {
  args: { launcherOpen: true, initialTabCount: 4 },
};

export const MaximizedDocument: Story = {
  args: { maximized: true, contentMode: "prose", initialTabCount: 4, initialActiveTabId: "document:review" },
};

export const FullBleedFile: Story = {
  args: { width: 620, initialTabCount: 6, initialActiveTabId: "file:driver", contentMode: "full-bleed" },
};

export const DarkAppearance: Story = {
  args: { dark: true, width: 560, initialTabCount: 5 },
};

export const MobileSheet: Story = {
  args: { presentation: "sheet", width: 390, initialTabCount: 6, initialActiveTabId: "document:plan" },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

export const TaskPagePersistentLauncher: Story = {
  name: "Task Page / Persistent Launcher",
  render: () => <TaskPagePersistentLauncherStory />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const taskPage = canvas.getByTestId("scrollable-task-page");
    taskPage.scrollTop = 900;
    taskPage.dispatchEvent(new Event("scroll", { bubbles: true }));

    const launcher = canvas.getByTestId("task-page-panel-launcher");
    await expect(launcher).toBeVisible();
    await userEvent.click(within(launcher).getByRole("button", { name: "Toggle side panel" }));
    await expect(canvas.queryByTestId("task-page-panel-launcher")).not.toBeInTheDocument();
    await expect(canvas.getByText("Task properties")).toBeVisible();

    await userEvent.click(canvas.getByRole("button", { name: "Toggle side panel" }));
    await expect(canvas.getByTestId("task-page-panel-launcher")).toBeVisible();
  },
};

export const KeyboardNavigationAndClose: Story = {
  args: { width: 620, initialTabCount: 4, initialActiveTabId: "properties" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const properties = await canvas.findByRole("tab", { name: "Properties" });
    properties.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByRole("tab", { name: "Plan" })).toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "Close Plan" }));
    await expect(canvas.queryByRole("tab", { name: "Plan" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("tab", { name: "Artifacts" })).toHaveAttribute("aria-selected", "true");
  },
};

export const PointerReorder: Story = {
  args: { width: 620, initialTabCount: 5, initialActiveTabId: "document:plan" },
  parameters: {
    docs: { description: { story: "Drag any tab by its capsule to reorder it with the pointer sensor." } },
  },
};

export const KeyboardReorder: Story = {
  args: { width: 620, initialTabCount: 4, initialActiveTabId: "properties" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const properties = await canvas.findByRole("tab", { name: "Properties" });
    properties.focus();
    await userEvent.keyboard("{Alt>}{Shift>}{ArrowRight}{/Shift}{/Alt}");
    const tabs = canvas.getAllByRole("tab");
    await expect(tabs[0]).toHaveAccessibleName("Plan");
    await expect(tabs[1]).toHaveAccessibleName("Properties");
  },
};

export const ClosingInactiveTab: Story = {
  args: { width: 620, initialTabCount: 4, initialActiveTabId: "document:plan" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const artifacts = await canvas.findByRole("tab", { name: "Artifacts" });
    await expect(canvas.queryByRole("button", { name: "Close Artifacts" })).not.toBeInTheDocument();
    await userEvent.pointer([
      { keys: "[MouseMiddle>]", target: artifacts },
      { keys: "[/MouseMiddle]", target: artifacts },
    ]);
    await expect(canvas.queryByRole("tab", { name: "Artifacts" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("tab", { name: "Plan" })).toHaveAttribute("aria-selected", "true");
  },
};

export const ClosingLastTab: Story = {
  args: { width: 380, initialTabCount: 1, initialActiveTabId: "properties" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Close Properties" }));
    await expect(canvas.queryByRole("tab")).not.toBeInTheDocument();
    await expect(await canvas.findByRole("combobox", { name: "Search tabs and resources…" })).toHaveFocus();
  },
};

function LauncherEdgeStatesHarness() {
  return (
    <div className="grid min-h-screen gap-6 bg-background p-6 text-foreground md:grid-cols-3">
      <SidePanelLauncher
        title="Loading section"
        sections={[{ id: "loading", label: "Recent files", loading: true, items: [] }]}
        onSelect={() => {}}
      />
      <SidePanelLauncher
        title="Partial failure"
        sections={[
          { id: "open", label: "Open", items: LAUNCHER_SECTIONS[0]!.items },
          { id: "error", label: "Recent files", error: "Recent files are temporarily unavailable.", items: [] },
        ]}
        onSelect={() => {}}
      />
      <SidePanelLauncher
        title="Disabled and open items"
        sections={[{
          id: "states",
          items: [
            { id: "open", label: "Properties", alreadyOpen: true, icon: <SlidersHorizontal /> },
            { id: "disabled", label: "Files", disabled: true, disabledReason: "No workspace is attached.", icon: <FolderOpen /> },
          ],
        }]}
        onSelect={() => {}}
      />
    </div>
  );
}

export const LauncherLoadingErrorAndDisabled: StoryObj = {
  render: () => <LauncherEdgeStatesHarness />,
};

function NonTaskHarness() {
  const tabs: SidePanelTabRecord<DemoPayload>[] = [
    { id: "details", type: "info", label: "Details", payload: { body: "Reusable outside task pages." }, closable: false },
    { id: "activity", type: "activity", label: "Activity", payload: { body: "Application activity." } },
    { id: "history", type: "history", label: "History", payload: { body: "Version history." } },
    { id: "settings", type: "settings", label: "Settings", payload: { body: "Local settings." } },
  ];
  const controller = useSidePanelTabs({ initialState: { tabs, activeTabId: "details" } });
  const active = controller.tabs.find((tab) => tab.id === controller.activeTabId)!;
  return (
    <div className="mx-auto h-screen max-w-xl bg-background p-6 text-foreground">
      <SidePanelFrame
        presentation="embedded"
        header={(
          <SidePanelTabs
            tabs={visualTabs(controller.tabs)}
            activeTabId={controller.activeTabId}
            onActiveTabChange={controller.selectTab}
            onCloseTab={controller.closeTab}
            onReorderTabs={controller.reorderTabs}
          />
        )}
      >
        <DemoContent tab={active} />
      </SidePanelFrame>
    </div>
  );
}

export const NonTaskComposition: StoryObj = {
  render: () => <NonTaskHarness />,
};

function TabAnatomyHarness() {
  return (
    <div className="flex min-h-screen flex-wrap content-start items-center gap-4 bg-background p-8 text-foreground">
      <SidePanelTab id="active" label="Active" icon={<Lightbulb />} active closable onSelect={() => {}} onClose={() => {}} />
      <SidePanelTab id="inactive" label="Inactive" icon={<FileText />} active={false} closable onSelect={() => {}} onClose={() => {}} />
      <SidePanelTab id="hovered" label="Hovered" icon={<Box />} active={false} closable className="bg-accent/55 text-foreground" onSelect={() => {}} onClose={() => {}} />
      <SidePanelTab id="focused" label="Keyboard focused" icon={<FolderOpen />} active={false} closable onSelect={() => {}} onClose={() => {}} />
      <SidePanelTab id="disabled" label="Disabled" icon={<FileCode2 />} active={false} disabled closable onSelect={() => {}} onClose={() => {}} />
      <SidePanelTab id="fixed" label="Non-closable" icon={<Info />} active={false} closable={false} onSelect={() => {}} />
      <SidePanelTab
        id="status"
        label="With status"
        icon={<FileText />}
        status={<span className="size-2 rounded-full bg-amber-500" aria-label="Modified" />}
        active={false}
        closable
        onSelect={() => {}}
        onClose={() => {}}
      />
      <SidePanelTab id="path" label="ui/src/components/side-panel/SidePanelTabs.tsx" icon={<FileCode2 />} active={false} closable onSelect={() => {}} onClose={() => {}} />
    </div>
  );
}

export const TabAnatomy: StoryObj = {
  render: () => <TabAnatomyHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole("tab", { name: "Inactive" }));
    canvas.getByRole("tab", { name: "Keyboard focused" }).focus();
  },
};

export const ToggleAndWindowControls: StoryObj = {
  render: () => (
    <div className="flex min-h-screen items-start gap-3 bg-background p-8 text-foreground">
      <SidePanelToggleButton open onToggle={interactionLog.hide} shortcut="]" />
      <SidePanelToggleButton open={false} onToggle={interactionLog.hide} shortcut="]" />
      <SidePanelWindowControls maximized={false} onMaximizedChange={interactionLog.maximize} onToggle={interactionLog.hide} />
      <SidePanelWindowControls maximized onMaximizedChange={interactionLog.restore} onToggle={interactionLog.hide} />
    </div>
  ),
};

function LauncherSearchHarness() {
  return (
    <div className="mx-auto h-screen max-w-xl bg-background p-6 text-foreground">
      <SidePanelLauncher sections={LAUNCHER_SECTIONS} onSelect={interactionLog.add} />
    </div>
  );
}

export const LauncherSearch: StoryObj = {
  render: () => <LauncherSearchHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvasElement.querySelector<HTMLInputElement>('input[aria-label="Search tabs and resources…"]');
    await expect(search).not.toBeNull();
    await userEvent.type(search!, "codex-driver");
    await expect(search).toHaveValue("codex-driver");
    await expect(canvas.getByText("codex-driver.md")).toBeVisible();
  },
};

export const LauncherNoResults: StoryObj = {
  render: () => <LauncherSearchHarness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const search = canvasElement.querySelector<HTMLInputElement>('input[aria-label="Search tabs and resources…"]');
    await expect(search).not.toBeNull();
    await userEvent.type(search!, "no-such-side-panel-resource");
    await expect(search).toHaveValue("no-such-side-panel-resource");
    await expect(canvas.getByText("No matching tabs or resources.")).toBeVisible();
  },
};

export const MinimumDocked: Story = { args: { width: 260, initialTabCount: 3 } };
export const WideDocked: Story = { args: { width: 760, initialTabCount: 5 } };
export const MobileFewTabs: Story = {
  args: { presentation: "sheet", width: 390, initialTabCount: 2 },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
export const MobileEmpty: Story = {
  args: { presentation: "sheet", width: 390, empty: true, initialTabCount: 0 },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
export const MobileLauncher: Story = {
  args: { presentation: "sheet", width: 390, launcherOpen: true, initialTabCount: 2 },
  parameters: { viewport: { defaultViewport: "mobile1" } },
};

type TaskFixtureState =
  | "first-properties"
  | "plan-loading"
  | "plan-missing"
  | "plan-populated"
  | "plan-annotated"
  | "plan-accepted"
  | "artifacts-empty"
  | "artifacts-populated"
  | "document"
  | "document-long"
  | "document-annotated"
  | "document-deleted"
  | "files-recent"
  | "files-search"
  | "files-folder"
  | "files-loading"
  | "files-error"
  | "files-no-workspace"
  | "file-loading"
  | "file-code"
  | "file-highlighted"
  | "file-binary"
  | "file-unavailable"
  | "file-fallback"
  | "mixed-overflow"
  | "persisted"
  | "empty"
  | "launcher"
  | "maximized-document"
  | "maximized-file";

const TASK_STATE_TITLE: Record<TaskFixtureState, string> = {
  "first-properties": "Properties",
  "plan-loading": "Loading plan",
  "plan-missing": "Plan not available",
  "plan-populated": "Implementation plan",
  "plan-annotated": "Implementation plan · 3 annotations",
  "plan-accepted": "Accepted plan history",
  "artifacts-empty": "No artifacts yet",
  "artifacts-populated": "Artifacts",
  document: "Architecture notes",
  "document-long": "Stress-derived paperclip runner workflow evaluation and release notes",
  "document-annotated": "Architecture notes · annotation selected",
  "document-deleted": "Document no longer available",
  "files-recent": "Recent workspace files",
  "files-search": "Search: side panel",
  "files-folder": "ui/src/components/side-panel",
  "files-loading": "Loading workspace",
  "files-error": "Recent files unavailable",
  "files-no-workspace": "No workspace available",
  "file-loading": "Loading SidePanelTabs.tsx",
  "file-code": "SidePanelTabs.tsx",
  "file-highlighted": "SidePanelTabs.tsx · line 142",
  "file-binary": "design-reference.psd",
  "file-unavailable": "removed-file.ts",
  "file-fallback": "File not found in execution workspace",
  "mixed-overflow": "Mixed task resources",
  persisted: "Persisted reordered state",
  empty: "Choose what to open",
  launcher: "Launcher open",
  "maximized-document": "Maximized architecture notes",
  "maximized-file": "Maximized SidePanelTabs.tsx",
};

function TaskFixtureContent({ state }: { state: TaskFixtureState }) {
  const title = TASK_STATE_TITLE[state];
  if (state.endsWith("loading")) {
    return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{title}…</div>;
  }
  if (state.includes("missing") || state.includes("deleted") || state.includes("error") || state.includes("unavailable") || state.includes("no-workspace")) {
    return (
      <div className="flex items-start gap-3 p-6 text-sm">
        <AlertTriangle className="size-5 text-amber-500" />
        <div><h2 className="font-medium">{title}</h2><p className="mt-1 text-muted-foreground">The tab remains open so the unavailable resource and recovery choices are explicit.</p></div>
      </div>
    );
  }
  if (state.startsWith("files-")) {
    return (
      <div className="grid h-full min-h-80 grid-cols-3 bg-muted/20">
        <div className="border-r border-border p-3 text-xs text-muted-foreground">Workspace<br />ui<br />src<br />components<br />side-panel</div>
        <div className="col-span-2 p-3"><h2 className="text-sm font-medium">{title}</h2><div className="mt-3 space-y-1 text-sm"><div className="rounded-md bg-accent px-2 py-1">SidePanelTabs.tsx</div><div className="px-2 py-1">SidePanelLauncher.tsx</div><div className="px-2 py-1">types.ts</div></div></div>
      </div>
    );
  }
  if (state.startsWith("file-") || state === "maximized-file") {
    if (state === "file-binary" || state === "file-fallback") {
      return <div className="p-6 text-sm"><h2 className="font-medium">{title}</h2><p className="mt-1 text-muted-foreground">Preview is unavailable. Download or try the project workspace.</p></div>;
    }
    return (
      <div className="h-full min-h-80 overflow-auto bg-(--code-bg-resolved) p-4 font-mono text-xs leading-6">
        <div className={state === "file-highlighted" ? "bg-(--code-highlight-bg-resolved)" : undefined}>142&nbsp; function selectTab(tabId: string) &#123;</div>
        <div>143&nbsp;&nbsp;&nbsp;controller.selectTab(tabId);</div>
        <div>144&nbsp;&nbsp;&nbsp;scrollSelectedTabIntoView();</div>
        <div>145&nbsp; &#125;</div>
      </div>
    );
  }
  if (state.startsWith("artifacts-")) {
    return state === "artifacts-empty"
      ? <div className="p-6 text-sm text-muted-foreground">Artifacts will appear here as the task produces documents and files.</div>
      : <div className="space-y-2 p-4"><h2 className="text-sm font-medium">Artifacts</h2>{["Implementation brief", "runner-report.json", "design-reference.png"].map((item) => <div key={item} className="rounded-lg border border-border p-3 text-sm">{item}</div>)}</div>;
  }
  return (
    <article className="mx-auto max-w-3xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm leading-6 text-muted-foreground">A deterministic read-only task fixture for central visual review of typography, annotations, metadata, spacing, and resource states.</p>
      {state.includes("annotated") ? <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm">Annotation thread anchored to this paragraph.</div> : null}
      {state === "plan-accepted" ? <div className="flex items-center gap-2 rounded-lg border border-border p-3 text-sm"><CheckCircle2 className="size-4 text-emerald-500" />Accepted revision 4 · two earlier revisions</div> : null}
    </article>
  );
}

function TaskCompositionFixture({ state }: { state: TaskFixtureState }) {
  const group = state.startsWith("artifacts-")
    ? "artifacts"
    : state.startsWith("files-")
      ? "files"
      : state.startsWith("file-") || state === "maximized-file"
        ? "file"
        : state.startsWith("document") || state === "maximized-document"
          ? "document"
          : state === "first-properties"
            ? "properties"
            : "plan";
  const initialTabs = state === "empty"
    ? []
    : state === "mixed-overflow"
      ? DEMO_TABS
      : state === "persisted"
        ? [DEMO_TABS[4]!, DEMO_TABS[1]!, DEMO_TABS[0]!]
        : group === "properties"
          ? [DEMO_TABS[0]!]
          : group === "artifacts"
            ? [DEMO_TABS[0]!, DEMO_TABS[2]!]
            : group === "files"
              ? [DEMO_TABS[0]!, DEMO_TABS[4]!]
              : group === "file"
                ? [DEMO_TABS[0]!, DEMO_TABS[4]!, DEMO_TABS[5]!]
                : group === "document"
                  ? [DEMO_TABS[0]!, DEMO_TABS[3]!]
                  : [DEMO_TABS[0]!, DEMO_TABS[1]!];
  const activeId = initialTabs.at(-1)?.id ?? null;
  const controller = useSidePanelTabs<DemoPayload>({ initialState: { tabs: initialTabs, activeTabId: activeId } });
  const [launcherOpen, setLauncherOpen] = useState(state === "launcher");
  const maximized = state.startsWith("maximized-");
  const sections = LAUNCHER_SECTIONS.map((section) => ({
    ...section,
    items: section.items.map((item) => ({ ...item, alreadyOpen: controller.tabs.some((tab) => tab.id === item.id) })),
  }));
  const launcher = (
    <SidePanelLauncher
      sections={sections}
      onSelect={(item) => {
        const tab = DEMO_TABS.find((candidate) => candidate.id === item.id);
        if (tab) controller.openTab(tab);
      }}
      presentation="popover"
      open={launcherOpen}
      onOpenChange={setLauncherOpen}
      trigger={<Button variant="ghost" size="icon-sm" className="h-(--side-panel-tab-height) w-(--side-panel-tab-height)" aria-label="Open a new tab"><Plus /></Button>}
    />
  );
  return (
    <div className="flex min-h-screen justify-end bg-background text-foreground">
      <div className={maximized ? "w-full" : "w-(--sz-420px)"}>
        <SidePanelFrame
          presentation="docked"
          maximized={maximized}
          contentMode={group === "files" || group === "file" ? "full-bleed" : "prose"}
          header={<SidePanelTabs tabs={visualTabs(controller.tabs)} activeTabId={controller.activeTabId} onActiveTabChange={controller.selectTab} onCloseTab={controller.closeTab} onReorderTabs={controller.reorderTabs} addControl={launcher} />}
          trailingControls={<SidePanelWindowControls maximized={maximized} onMaximizedChange={() => {}} onToggle={() => {}} />}
        >
          {controller.tabs.length === 0
            ? <SidePanelLauncher sections={sections} onSelect={() => {}} />
            : <TaskFixtureContent state={state} />}
        </SidePanelFrame>
      </div>
    </div>
  );
}

function taskStory(state: TaskFixtureState): StoryObj {
  return { render: () => <TaskCompositionFixture state={state} /> };
}

export const TaskFirstVisitProperties = taskStory("first-properties");
export const TaskPlanningSelectedPlan = taskStory("plan-populated");
export const TaskPlanLoading = taskStory("plan-loading");
export const TaskPlanMissing = taskStory("plan-missing");
export const TaskPlanAnnotated = taskStory("plan-annotated");
export const TaskPlanAcceptedHistory = taskStory("plan-accepted");
export const TaskArtifactsEmpty = taskStory("artifacts-empty");
export const TaskArtifactsPopulated = taskStory("artifacts-populated");
export const TaskOrdinaryDocument = taskStory("document");
export const TaskLongDocument = taskStory("document-long");
export const TaskAnnotatedDocument = taskStory("document-annotated");
export const TaskDeletedDocument = taskStory("document-deleted");
export const TaskFilesRecent = taskStory("files-recent");
export const TaskFilesSearch = taskStory("files-search");
export const TaskFilesFolder = taskStory("files-folder");
export const TaskFilesLoading = taskStory("files-loading");
export const TaskFilesError = taskStory("files-error");
export const TaskFilesNoWorkspace = taskStory("files-no-workspace");
export const TaskWorkspaceFileLoading = taskStory("file-loading");
export const TaskWorkspaceFileCode = taskStory("file-code");
export const TaskWorkspaceFileHighlightedLine = taskStory("file-highlighted");
export const TaskWorkspaceFileBinary = taskStory("file-binary");
export const TaskWorkspaceFileUnavailable = taskStory("file-unavailable");
export const TaskWorkspaceFileAlternateWorkspace = taskStory("file-fallback");
export const TaskMixedOverflow = taskStory("mixed-overflow");
export const TaskPersistedState = taskStory("persisted");
export const TaskIntentionallyEmpty = taskStory("empty");
export const TaskLauncherOpen = taskStory("launcher");
export const TaskMaximizedDocument = taskStory("maximized-document");
export const TaskMaximizedFile = taskStory("maximized-file");
