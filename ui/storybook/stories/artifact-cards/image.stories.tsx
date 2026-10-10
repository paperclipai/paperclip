import type { Meta, StoryObj } from "@storybook/react-vite";
import { ImageCard } from "@/components/artifacts/RichArtifactCards";
import {
  decorators,
  parameters,
  identityControls,
  textData,
  numberData,
} from "./storyConfig";
import posterUrl from "../../fixtures/artifact-media/paper-trail.png?url";

const meta = {
  title: "Explorations/Artifact cards/Image",
  component: ImageCard,
  decorators,
  parameters,
  argTypes: {
    ...identityControls,
    filename: textData("Original image filename."),
    imageUrl: textData(
      "The image source URL. The preview is an actual image, not a hardcoded Settings component.",
    ),
    alt: textData("Description of the image for assistive technology."),
    width: numberData("Image width from file metadata."),
    height: numberData("Image height from file metadata."),
  },
} satisfies Meta<typeof ImageCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// Every artifact-specific example value is editable through Storybook Controls.
export const Image: Story = {
  name: "Image",
  args: {
    title: "Paper Trail concept",
    summary: "",
    author: "Codie",
    updatedAt: "Sep 26, 2026",
    filename: "paper-trail.png",
    imageUrl: posterUrl,
    alt: "Paper Trail visual concept",
    width: 400,
    height: 400,
  },
};
