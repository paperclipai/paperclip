import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataCard } from "@/components/artifacts/RichArtifactCards";
import {
  decorators,
  parameters,
  identityControls,
  textData,
  objectData,
} from "./storyConfig";

const meta = {
  title: "Explorations/Artifact cards/Data",
  component: DataCard,
  decorators,
  parameters,
  argTypes: {
    ...identityControls,
    filename: textData("Filename used when downloading the data."),
    columns: objectData(
      "Editable JSON array of column names. No column names are hardcoded in the renderer.",
    ),
    rows: objectData(
      "Editable JSON array of rows. The card previews three; View data shows all. Counts and CSV download follow this data.",
    ),
  },
} satisfies Meta<typeof DataCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// Every artifact-specific example value is editable through Storybook Controls.
export const Data: Story = {
  name: "Data",
  args: {
    title: "Signup report",
    summary: "",
    author: "Codie",
    updatedAt: "Sep 26, 2026",
    filename: "signups.csv",
    columns: ["Region", "Signups", "Conversion"],
    rows: [
      ["North America", 1240, "8.2%"],
      ["Europe", 980, "7.6%"],
      ["Asia Pacific", 720, "6.9%"],
      ["Latin America", 410, "7.1%"],
    ],
  },
};
