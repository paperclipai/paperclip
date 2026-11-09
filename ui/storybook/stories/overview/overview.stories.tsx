import type { Meta, StoryObj } from "@storybook/react-vite";
import { FeatureMapIndex } from "../../support/feature-map/FeatureOverview";

const meta = {
  id: "overview-storybook-guide",
  title: "Overview/Storybook Guide",
  component: FeatureMapIndex,
  parameters: { docs: { description: { component: "Feature-based navigation from the downstream catalog, with separate product, component, and fixture classifications. Story links come from this build's index." } },
    paperclip: {
      "capabilities": [],
      "implementation": "guide",
      "boundary": "static",
      "notes": "Matches the upstream feature index and order, including features with no cataloged examples. Related suite links and classifications do not imply execution coverage. The generated upstream feature index was reconciled; example scope and classifications are retained.",
      "exception": "Shared foundations or contributor guide; no single business capability owns this suite."
    },
  },
} satisfies Meta<typeof FeatureMapIndex>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CoverageGuide: Story = {};
