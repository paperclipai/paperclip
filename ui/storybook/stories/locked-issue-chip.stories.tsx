import type { Meta, StoryObj } from "@storybook/react-vite";
import { LockedIssueChip } from "@/components/LockedIssueChip";

const meta: Meta<typeof LockedIssueChip> = {
  title: "Privacy/LockedIssueChip",
  component: LockedIssueChip,
  parameters: { layout: "centered" },
};
export default meta;

type Story = StoryObj<typeof LockedIssueChip>;

export const WithIdentifier: Story = {
  args: { identifier: "PAP-1234" },
};

export const IdentifierWithheld: Story = {
  args: { identifier: null },
};

export const InABlockerRow: Story = {
  render: () => (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/70 bg-background/80 px-2 py-1">
      <LockedIssueChip identifier="PAP-982" />
      <span className="text-(length:--text-micro) text-amber-800 dark:text-amber-200">
        Private — you don't have access
      </span>
    </div>
  ),
};

export const InlineInAComment: Story = {
  render: () => (
    <p className="max-w-sm text-sm">
      This depends on <LockedIssueChip identifier="PAP-7" /> which you can't see, so the plan is
      still gated.
    </p>
  ),
};
