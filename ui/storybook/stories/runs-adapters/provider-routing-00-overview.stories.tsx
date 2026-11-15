import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReviewIndex } from "../../prototypes/provider-routing/ReviewIndex";
import { ReviewFrame } from "../../prototypes/provider-routing/shared";
import { reviewLifecycle } from "../../prototypes/provider-routing/story-support";
const meta = {
  id: "ai-connections-provider-routing-00-overview",
  title: "Agents and reusable capabilities/Runs, harnesses, and model accounts/AI Connections/Provider routing/00 Overview",
  component: ReviewIndex,
  parameters: { layout: "fullscreen",
    paperclip: {
      "capabilities": [
        "runs-adapters/validation"
      ],
      "implementation": "guide",
      "boundary": "static",
      "notes": "Review guide retained; explanatory content does not establish runtime or production coverage."
    },
  },
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
