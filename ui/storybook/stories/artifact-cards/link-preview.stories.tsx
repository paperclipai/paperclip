import type { Meta, StoryObj } from "@storybook/react-vite";
import { LinkPreviewCard } from "@/components/artifacts/RichArtifactCards";
import {
  decorators,
  parameters,
  identityControls,
  textData,
} from "./storyConfig";

const meta = {
  title: "Explorations/Artifact cards/Link preview",
  component: LinkPreviewCard,
  decorators,
  parameters,
  argTypes: {
    ...identityControls,
    url: textData(
      "Saved destination URL. There is no embedded app or simulated workspace.",
    ),
    imageUrl: textData(
      "Optional saved screenshot or link image URL. Empty means no thumbnail.",
    ),
    imageAlt: textData("Description of the optional image."),
  },
} satisfies Meta<typeof LinkPreviewCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// Every artifact-specific example value is editable through Storybook Controls.
export const LinkPreview: Story = {
  name: "Link preview",
  args: {
    title: "Project website",
    summary: "A link saved by the agent.",
    author: "Codie",
    updatedAt: "Sep 26, 2026",
    url: "https://example.com",
    imageUrl: "",
    imageAlt: "",
  },
};
