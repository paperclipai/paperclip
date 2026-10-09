import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReviewIndex } from "../prototypes/provider-routing/ReviewIndex";
import { ReviewFrame } from "../prototypes/provider-routing/shared";
import { reviewLifecycle } from "../prototypes/provider-routing/story-support";
const meta = {
  title: "AI Connections/Provider routing/00 Overview",
  component: ReviewIndex,
  parameters: { layout: "fullscreen" },
  ...reviewLifecycle,
  decorators: [
    (Story) => (
      <ReviewFrame location="Review map and scope; this page has no production app location.">
        <Story />
      </ReviewFrame>
    ),
  ],
} satisfies Meta<typeof ReviewIndex>;
export default meta;
export const StartHere: StoryObj<typeof meta> = {};
