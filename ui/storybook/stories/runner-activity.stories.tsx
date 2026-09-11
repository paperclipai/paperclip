import type { Meta, StoryObj } from "@storybook/react-vite";
import { MINIMAL_VIEWPORTS } from "storybook/viewport";
import { RunnerActivityPreview } from "../prototypes/runner-activity/RunnerActivityPreview";

const meta = {
  title: "Tasks/Runner activity preview",
  component: RunnerActivityPreview,
  globals: { viewport: { value: "desktop", isRotated: false } },
  parameters: {
    layout: "fullscreen",
    viewport: {
      options: {
        ...MINIMAL_VIEWPORTS,
        desktop: {
          name: "Desktop",
          styles: { width: "100%", height: "100%" },
          type: "desktop",
        },
      },
    },
    docs: {
      description: {
        component:
          "Production runner turn with deterministic event playback. Each commentary boundary starts a separate activity group. Compact groups roll through one tool or thinking item at a time. Expand a group to keep its history growing inline, and click any expanded row to inspect its detail. Pause, Next, and Replay control simulated events; no runner or task API is called.",
      },
    },
  },
} satisfies Meta<typeof RunnerActivityPreview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopLive: Story = {
  name: "01 · Desktop live · animated",
  args: { initialStep: 1, autoPlay: true, narrow: false },
};
export const LiveCompact: Story = {
  name: "Compact · paused",
  args: { autoPlay: false },
};
export const LiveExpanded: Story = {
  name: "02 · Desktop expanded · animated",
  args: { expanded: true, autoPlay: true, narrow: false },
};
export const BetweenCommentary: Story = {
  name: "03 · Between commentary",
  args: { initialStep: 12, autoPlay: false },
};
export const IconAlignment: Story = {
  name: "04 · Icon alignment",
  args: { initialStep: 12, autoPlay: false, expanded: true },
};
export const LongLabels: Story = {
  name: "05 · Long labels & narrow layout",
  args: { initialStep: 8, autoPlay: false, narrow: true, longLabels: true },
};
export const Failure: Story = {
  name: "06 · Failure stays visible",
  args: { initialStep: 12, autoPlay: false, failed: true },
};
export const Light: Story = { name: "07 · Light", globals: { theme: "light" } };
export const Mobile: Story = {
  name: "08 · Mobile live · animated",
  args: { narrow: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
