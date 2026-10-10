import type { Meta, StoryObj } from "@storybook/react-vite";
import { MINIMAL_VIEWPORTS } from "storybook/viewport";
import { CompletedActivityPreview } from "../prototypes/completed-activity/CompletedActivityPreview";

const meta = {
  title: "Tasks/Completed activity preview",
  component: CompletedActivityPreview,
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
          "Production runner activity group. Completed commentary groups collapse to short action summaries. No failure counts in either state. Expand to see the original one-line activity rows and their full details. The live stories show a group settling while the next group starts.",
      },
    },
  },
} satisfies Meta<typeof CompletedActivityPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Conversation: Story = { name: "01 · Completed conversation" };
export const Situations: Story = {
  name: "02 · Summary situations",
  args: { mode: "gallery" },
};
export const DesktopLive: Story = {
  name: "03 · Desktop live to completed",
  args: { mode: "live" },
};
export const Expanded: Story = {
  name: "04 · Expanded history",
  args: { expanded: true },
};
export const ExpandedLive: Story = {
  name: "05 · Expanded live to completed",
  args: { mode: "live", expanded: true },
};
export const MobileLive: Story = {
  name: "06 · Mobile live to completed",
  args: { mode: "live", narrow: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const MobileSituations: Story = {
  name: "07 · Mobile summary situations",
  args: { mode: "gallery", narrow: true },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
export const Light: Story = { name: "08 · Light", globals: { theme: "light" } };
