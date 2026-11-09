import type { Meta, StoryObj } from "@storybook/react-vite";
import { CommitCard } from "@/components/artifacts/RichArtifactCards";
import {
  decorators,
  parameters,
  identityControls,
  textData,
  diffControls,
} from "../../../support/artifact-cards/storyConfig";

const meta = {
  id: "explorations-artifact-cards-commit",
  title: "Tasks and conversations/Documents, attachments, and work products/Explorations/Artifact cards/Commit",
  component: CommitCard,
  decorators,
  parameters: { ...parameters, paperclip: {
      "capabilities": [
        "documents-artifacts/work-products"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    } },
  argTypes: {
    ...identityControls,
    ...diffControls,
    sha: textData("Commit SHA; the card displays the first eight characters."),
    repository: textData("Repository owner/name."),
    branch: textData("Branch name. Clear to hide."),
    url: textData("Destination for the fixed View commit action."),
  },
} satisfies Meta<typeof CommitCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// Every artifact-specific example value is editable through Storybook Controls.
export const Commit: Story = {
  name: "Commit",
  args: {
    title: "Historical-schema worktree fixture fix",
    summary:
      "Insert historical user columns explicitly so worktree seeding tests work against the older schema.",
    author: "Codie",
    updatedAt: "Sep 26, 2026",
    sha: "1c3c9ddfddc755a4c45b3644d3d4b21abcdde43c",
    repository: "paperclipai/paperclip",
    branch: "fix/personal-keyboard-shortcut-preference",
    additions: 12,
    deletions: 8,
    filesChanged: 1,
    url: "https://github.com/paperclipai/paperclip/commit/1c3c9ddfddc755a4c45b3644d3d4b21abcdde43c",
  },
};
