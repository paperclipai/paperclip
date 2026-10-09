import { useState } from "react";
import { Button } from "@/components/ui/button";
import { expect, userEvent, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { TaskSidePanel } from "@/components/task-side-panel/TaskSidePanel";
import { TaskBrowserPanel } from "@/components/task-side-panel/TaskBrowserPanel";
import { storybookIssues } from "../fixtures/paperclipData";
import {
  BrowserStoryProviders,
  InteractiveBrowserStory,
  browserFixture,
  browserState,
  mockBrowserUse,
} from "../fixtures/browser-use";

const meta = {
  title: "Tasks/Browser Use/Panel",
  component: TaskBrowserPanel,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Production Browser panel with offline provider fixtures. Fit to pane follows the available viewport after a short debounce. Fixed presets retain their dimensions. The provider interaction is mocked; live resize support was tested separately. No credentials or paid runs are used.",
      },
    },
  },
  args: { issueId: "browser-story" },
  beforeEach: () => mockBrowserUse(),
  decorators: [
    (Story) => (
      <BrowserStoryProviders>
        <div className="h-screen bg-background text-foreground">
          <Story />
        </div>
      </BrowserStoryProviders>
    ),
  ],
} satisfies Meta<typeof TaskBrowserPanel>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Running: Story = {
  render: () => <InteractiveBrowserStory initial={browserState("running")} />,
};
export const Idle: Story = {
  render: () => <InteractiveBrowserStory initial={browserState("idle")} />,
};
export const ClosingSoon: Story = {
  render: () => <InteractiveBrowserStory initial={browserState("idle", 282)} />,
};
export const Starting: Story = { args: { browser: browserState("starting") } };
export const Connecting: Story = {
  args: { browser: browserState("running") },
  beforeEach: () => mockBrowserUse({ loading: true }),
};
export const Disconnected: Story = {
  ...Running,
  beforeEach: () => mockBrowserUse({ disconnected: true }),
};
export const ControlFailure: Story = {
  ...Running,
  beforeEach: () => mockBrowserUse({ controlError: true }),
};
export const Closed: Story = { args: { browser: browserState("closed") } };
export const ClosedWithActiveBrowser: Story = {
  render: () => {
    const [opened, setOpened] = useState(false);
    return opened ? <InteractiveBrowserStory initial={browserState("idle")} /> : (
      <TaskBrowserPanel issueId="browser-story" browser={browserState("closed")} onOpenActiveBrowser={() => setOpened(true)} />
    );
  },
};
export const Failed: Story = {
  args: {
    browser: {
      ...browserState("failed"),
      error:
        "Browser Use could not start this browser. Check the connection and send the agent another message.",
    },
  },
};
export const Stopping: Story = { args: { browser: browserState("stopping") } };
export const Revoked: Story = { args: { accessError: true } };
export const Empty: Story = {};
export const Narrow: Story = {
  render: () => (
    <div className="h-full w-80 border-x">
      <InteractiveBrowserStory initial={browserState("idle", 282)} />
    </div>
  ),
};
export const Light: Story = { ...Running, globals: { theme: "light" } };
export const PanelTabs: Story = {
  render: () => (
    <TaskSidePanel
      issue={storybookIssues[0]}
      accountScope="browser-use-storybook-v2"
      openBrowserId={browserFixture.id}
      onUpdate={() => {}}
      fileTabsEnabled={false}
      streamlinedTabs
    />
  ),
};
export const MobilePanel: Story = {
  render: () => (
    <div className="h-full w-80 border-x">
      <TaskSidePanel
        issue={storybookIssues[0]}
        accountScope="browser-use-storybook-mobile-v2"
        openBrowserId={browserFixture.id}
        onUpdate={() => {}}
        fileTabsEnabled={false}
        streamlinedTabs
      />
    </div>
  ),
};

export const FixedPhone: Story = {
  ...Idle,
  beforeEach: () => mockBrowserUse({ viewport: "phone" }),
};
export const FixedTablet: Story = {
  ...Idle,
  beforeEach: () => mockBrowserUse({ viewport: "tablet" }),
};
export const FixedLaptop: Story = {
  ...Idle,
  beforeEach: () => mockBrowserUse({ viewport: "laptop" }),
};
export const FixedDesktop: Story = {
  ...Idle,
  beforeEach: () => mockBrowserUse({ viewport: "desktop" }),
};
const choosePhone = async (canvasElement: HTMLElement) => {
  await userEvent.click(
    within(canvasElement).getByRole("button", { name: "Browser options" }),
  );
  const body = within(canvasElement.ownerDocument.body);
  body.getByRole("menuitem", { name: /Browser size/ }).focus();
  await userEvent.keyboard("{ArrowRight}");
  await userEvent.click(body.getByRole("menuitemradio", { name: /Phone/ }));
};
export const ChangeSize: Story = {
  ...Idle,
  play: async ({ canvasElement }) => {
    await choosePhone(canvasElement);
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Browser options" }),
    );
    const body = within(canvasElement.ownerDocument.body);
    body.getByRole("menuitem", { name: /Browser size/ }).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(
      body.getByRole("menuitemradio", { name: /Phone/ }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(canvasElement).not.toHaveTextContent("$0.15");
  },
};
export const ResizeFailure: Story = {
  ...Idle,
  beforeEach: () => mockBrowserUse({ resizeError: true, viewport: "laptop" }),
  play: async ({ canvasElement }) => {
    await choosePhone(canvasElement);
    await expect(within(canvasElement).getByRole("alert")).toHaveTextContent(
      "Browser size could not be changed",
    );
  },
};
export const Resizing: Story = {
  ...Idle,
  beforeEach: () => mockBrowserUse({ resizing: true, viewport: "laptop" }),
  play: async ({ canvasElement }) => {
    await choosePhone(canvasElement);
  },
};

function ResizableBrowserStory() {
  const [width, setWidth] = useState(560);
  const [height, setHeight] = useState(640);
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setWidth(360)}>
          Narrow pane
        </Button>
        <Button variant="outline" size="sm" onClick={() => setWidth(800)}>
          Wide pane
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setHeight(height === 640 ? 440 : 640)}
        >
          Change height
        </Button>
        <span className="text-xs text-muted-foreground">
          Drag the lower-right corner. Choose a fixed size to stop fitting.
        </span>
      </div>
      <div
        className="max-w-full shrink-0 overflow-hidden rounded-md border"
        style={{ width, height, resize: "both" }}
      >
        <InteractiveBrowserStory initial={browserState("idle")} />
      </div>
    </div>
  );
}
export const FitToPane: Story = { render: () => <ResizableBrowserStory /> };
export const FitFailure: Story = {
  ...Idle,
  beforeEach: () => mockBrowserUse({ resizeError: true }),
};
export const AnotherViewerControlsSize: Story = {
  ...Idle,
  beforeEach: () => mockBrowserUse({ controlledElsewhere: true }),
};
export const TwoViewers: Story = {
  render: () => (
    <div className="flex h-full gap-4 p-4">
      <div className="flex w-80 flex-col gap-2">
        <p className="text-sm">First viewer</p>
        <div className="min-h-0 flex-1 border">
          <InteractiveBrowserStory initial={browserState("idle")} />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm">Second viewer</p>
        <div className="min-h-0 flex-1 border">
          <InteractiveBrowserStory initial={browserState("idle")} />
        </div>
      </div>
    </div>
  ),
};
