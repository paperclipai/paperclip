import type { Meta, StoryObj } from "@storybook/react-vite";
import { FileCard } from "@/components/artifacts/RichArtifactCards";
import {
  decorators,
  parameters,
  identityControls,
  textData,
  objectData,
} from "./storyConfig";

const meta = {
  title: "Explorations/Artifact cards/File",
  component: FileCard,
  decorators,
  parameters,
  argTypes: {
    ...identityControls,
    filename: textData("Original file name, also used for download."),
    contentType: textData("MIME type from file metadata."),
    fileSize: textData("Formatted file size."),
    entries: objectData(
      "Optional archive entries as a JSON array of file paths. Empty hides the list.",
    ),
    openUrl: textData(
      "Optional URL for opening the original file in a browser tab.",
    ),
    downloadUrl: textData(
      "Stored file URL. Empty disables download. This example supplies a tiny text file.",
    ),
  },
} satisfies Meta<typeof FileCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// Every artifact-specific example value is editable through Storybook Controls.
export const File: Story = {
  name: "File",
  args: {
    title: "Release notes",
    summary: "",
    author: "Codie",
    updatedAt: "Sep 26, 2026",
    filename: "release-notes.txt",
    contentType: "text/plain",
    fileSize: "42 B",
    entries: [],
    openUrl: "",
    downloadUrl:
      "data:text/plain;charset=utf-8,Personal%20keyboard%20shortcuts%20are%20available.%0A",
  },
};
