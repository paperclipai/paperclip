import type { Meta, StoryObj } from "@storybook/react-vite";
import { DeckProductFlowHarness } from "@/deck-product-flow/ProductFlowHarness";

const meta: Meta<typeof DeckProductFlowHarness> = {
  title: "Product/Deck Product Flow",
  component: DeckProductFlowHarness,
  parameters: {
    layout: "fullscreen",
    viewport: {
      defaultViewport: "desktop",
    },
  },
  argTypes: {
    initialFrame: {
      control: { type: "number", min: 0, max: 3, step: 1 },
    },
    mode: {
      control: "radio",
      options: ["capture", "embed"],
    },
  },
};

export default meta;

type Story = StoryObj<typeof DeckProductFlowHarness>;

export const CapturedProductMotion: Story = {
  args: {
    initialFrame: 1,
    mode: "capture",
  },
};

export const SandboxedLiveMockup: Story = {
  args: {
    initialFrame: 0,
    mode: "embed",
  },
};
