import type { Meta, StoryObj } from "@storybook/react-vite";
import { PullRequestCard } from "@/components/artifacts/RichArtifactCards";
import {
  decorators,
  parameters,
  identityControls,
  textData,
  numberData,
  diffControls,
} from "./storyConfig";

const meta = {
  title: "Explorations/Artifact cards/Pull request",
  component: PullRequestCard,
  decorators,
  parameters,
  argTypes: {
    ...identityControls,
    ...diffControls,
    number: numberData("Pull request number."),
    repository: textData("Repository owner/name."),
    sourceBranch: textData("Source branch."),
    targetBranch: textData("Target branch."),
    state: {
      control: "select",
      options: ["open", "draft", "merged", "closed", "unknown"],
      description: "Saved PR state. The component formats its label.",
      table: { category: "Artifact data" },
    },
    checks: {
      control: "select",
      options: ["passed", "pending", "failed", "unknown"],
      description: "Reported check state, not a live query.",
      table: { category: "Artifact data" },
    },
    evidenceSource: textData(
      "Where the displayed check/review information came from. Clear to hide.",
    ),
    reviewSummary: textData("Optional reported review result. Clear to hide."),
    url: textData("Destination for the fixed Open pull request action."),
  },
} satisfies Meta<typeof PullRequestCard>;
export default meta;
type Story = StoryObj<typeof meta>;

// Every artifact-specific example value is editable through Storybook Controls.
export const PullRequest: Story = {
  name: "Pull request",
  args: {
    title: "Per-user keyboard shortcut preference",
    summary:
      "Each user can enable keyboard shortcuts in Profile without administrator access.",
    author: "Codie",
    updatedAt: "Sep 26, 2026",
    number: 14141,
    repository: "paperclipai/paperclip",
    sourceBranch: "fix/personal-keyboard-shortcut-preference",
    targetBranch: "master",
    state: "merged",
    checks: "passed",
    evidenceSource: "Codie’s Sep 26, 11:50 AM handoff",
    reviewSummary: "Greptile 5/5 · 6 review threads resolved",
    additions: 1159,
    deletions: 68,
    filesChanged: 30,
    url: "https://github.com/paperclipai/paperclip/pull/14141",
  },
};
