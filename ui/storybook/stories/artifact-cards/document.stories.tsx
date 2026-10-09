import type { Meta, StoryObj } from "@storybook/react-vite";
import { DocumentCard } from "@/components/artifacts/RichArtifactCards";
import {
  decorators,
  parameters,
  identityControls,
  textData,
  numberData,
} from "./storyConfig";

const meta = {
  title: "Explorations/Artifact cards/Document",
  component: DocumentCard,
  decorators,
  parameters,
  argTypes: {
    ...identityControls,
    filename: textData("Actual document filename."),
    revision: numberData("Document revision number."),
    body: {
      ...textData(
        "The document’s actual Markdown body. Every word in the preview comes from this control.",
      ),
      table: { category: "Artifact content" },
    },
  },
} satisfies Meta<typeof DocumentCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// Every artifact-specific example value is editable through Storybook Controls.
export const Document: Story = {
  name: "Document",
  args: {
    title: "Rollout brief",
    summary: "",
    author: "Codie",
    updatedAt: "Sep 26, 2026",
    filename: "rollout-brief.md",
    revision: 3,
    body: "## Ready for rollout\n\nKeyboard shortcuts are now a personal preference.\n\n- Available to every user.\n- Off by default after upgrade.\n- Changes apply only to the signed-in account.",
  },
};
