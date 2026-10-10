import type { Meta, StoryObj } from "@storybook/react-vite";
import { VideoCard } from "@/components/artifacts/RichArtifactCards";
import {
  decorators,
  parameters,
  identityControls,
  textData,
} from "./storyConfig";
import posterUrl from "../../fixtures/artifact-media/paper-trail.png?url";
import videoUrl from "../../fixtures/artifact-media/paper-trail.mp4?url";

const meta = {
  title: "Explorations/Artifact cards/Video",
  component: VideoCard,
  decorators,
  parameters,
  argTypes: {
    ...identityControls,
    filename: textData("Original video filename."),
    videoUrl: textData("Playable video source URL."),
    posterUrl: textData("Poster image source URL."),
    duration: textData("Duration from media metadata."),
  },
} satisfies Meta<typeof VideoCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// Every artifact-specific example value is editable through Storybook Controls.
export const Video: Story = {
  name: "Video",
  args: {
    title: "Paper Trail motion study",
    summary: "",
    author: "Codie",
    updatedAt: "Sep 26, 2026",
    filename: "paper-trail.mp4",
    videoUrl: videoUrl,
    posterUrl: posterUrl,
    duration: "0:03",
  },
};
