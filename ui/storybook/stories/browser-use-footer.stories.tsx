import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import type {
  BrowserUseControl,
  BrowserUseViewportPreset,
  TaskBrowser,
} from "@paperclipai/shared";
import { TaskBrowserFooter } from "@/components/task-side-panel/TaskBrowserFooter";
import { browserFixture } from "../fixtures/browser-use";
const now = Date.parse("2026-09-29T16:00:00Z");
const idle = (seconds: number): TaskBrowser => ({
  ...browserFixture,
  status: "idle",
  idleDeadline: new Date(now + seconds * 1000).toISOString(),
});
const meta = {
  title: "Tasks/Browser Use/Footer",
  component: TaskBrowserFooter,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "The quiet footer: contextual Stop browsing and an options menu with automatic fitting and fixed viewport presets. Costs are recorded on the task and hidden here. Countdown appears only at five minutes or less. Keep browsing resets idle time; it cannot extend the provider’s lifetime limit.",
      },
    },
  },
  args: {
    browser: idle(600),
    now,
    onControl: () => {},
    onReconnect: () => {},
    onResize: () => {},
  },
  decorators: [
    (Story) => (
      <div className="w-96 max-w-full bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TaskBrowserFooter>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Idle: Story = {};
export const Running: Story = { args: { browser: browserFixture } };
export const ClosingSoon: Story = { args: { browser: idle(282) } };
export const FiveMinuteBoundary: Story = { args: { browser: idle(300) } };
export const AboveFiveMinutes: Story = { args: { browser: idle(301) } };
export const Closing: Story = { args: { browser: idle(0) } };
export const LifetimeLimit: Story = {
  args: {
    browser: { ...idle(600), expiresAt: new Date(now + 120000).toISOString() },
  },
};
export const PendingAction: Story = {
  args: { browser: idle(282), disabled: true },
};
export const Closed: Story = {
  args: { browser: { ...browserFixture, status: "closed" } },
};
export const Light: Story = { ...ClosingSoon, globals: { theme: "light" } };
function InteractiveFooter() {
  const [viewport, setViewport] = useState<BrowserUseViewportPreset>("fit");
  const [browser, setBrowser] = useState(idle(282));
  const [lastAction, setLastAction] = useState(
    "Open Browser options to inspect each action.",
  );
  const control = (action: BrowserUseControl) => {
    setBrowser(action === "end" ? { ...browser, status: "closed" } : idle(600));
    setLastAction(
      action === "end"
        ? "Browser closed (simulation)."
        : "Idle timer reset to ten minutes (simulation).",
    );
  };
  return (
    <>
      <p className="p-3 text-xs text-muted-foreground" role="status">
        {lastAction}
      </p>
      <TaskBrowserFooter
        browser={browser}
        now={now}
        viewport={viewport}
        onResize={(preset) => {
          setViewport(preset);
          setLastAction(
            preset === "fit"
              ? "Viewport follows this pane (simulation)."
              : preset === "default"
                ? "Original browser size restored (simulation)."
                : `Fixed ${preset} viewport selected (simulation).`,
          );
        }}
        onControl={control}
        onReconnect={() =>
          setLastAction(
            "Live view reconnected; the browser kept running (simulation).",
          )
        }
      />
    </>
  );
}
export const Interactive: Story = { render: () => <InteractiveFooter /> };

export const OptionsMenu: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Browser options" }),
    );
  },
};
export const Narrow: Story = {
  ...ClosingSoon,
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
};

export const FixedPhone: Story = { args: { viewport: "phone" } };
export const FixedTablet: Story = { args: { viewport: "tablet" } };
export const FixedLaptop: Story = { args: { viewport: "laptop" } };
export const FixedDesktop: Story = { args: { viewport: "desktop" } };
export const Resizing: Story = {
  args: { resizing: true, browser: browserFixture },
};
export const SizeMenu: Story = {
  args: { viewport: "laptop" },
  play: async ({ canvasElement }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Browser options" }),
    );
    const body = within(canvasElement.ownerDocument.body);
    const menu = body.getByRole("menuitem", { name: /Browser size/ });
    menu.focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(
      body.getByRole("menuitemradio", { name: /Laptop/ }),
    ).toHaveAttribute("aria-checked", "true");
    await expect(canvasElement).not.toHaveTextContent("$0.15");
  },
};

export const FitToPane: Story = { args: { viewport: "fit" } };
export const AnotherViewerControlsSize: Story = {
  args: { viewport: "fit", controlledElsewhere: true },
};
