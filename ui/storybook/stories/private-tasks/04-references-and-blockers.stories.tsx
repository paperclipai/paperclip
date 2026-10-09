import type { IssueRelationIssueSummary } from "@paperclipai/shared";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { RelationNavigationList } from "@/components/task-detail/TaskDetailRelationsPanel";
import { LockedIssueChip } from "@/components/LockedIssueChip";
import { IssueReferencePill } from "@/components/IssueReferencePill";
import { IssueBlockedNotice } from "@/components/IssueBlockedNotice";
import { MarkdownBody } from "@/components/MarkdownBody";
import { RemovableIssueReferencePill } from "@/components/issue-properties/relation-controls";
import {
  mobile,
  privacyDecorator,
  privacyParameters,
  StoryFrame,
} from "./PrivacyStory";

const locked = {
  id: "privacy-root",
  identifier: "PAP-410",
  locked: true as const,
};
// Runtime redaction deliberately omits private title/status fields.
const lockedBlocker = locked as unknown as IssueRelationIssueSummary;
const readable: IssueRelationIssueSummary = {
  id: "privacy-child",
  identifier: "PAP-411",
  title: "Research market benchmarks",
  status: "todo",
  priority: "medium",
  assigneeAgentId: null,
  assigneeUserId: null,
};
function References({
  mode = "chips",
  mobileControl = false,
}: {
  mode?: "chips" | "pills" | "markdown" | "blocker" | "mixed" | "remove";
  mobileControl?: boolean;
}) {
  const [removed, setRemoved] = useState(false);
  return (
    <StoryFrame
      title="References across a privacy boundary"
      story="As someone working on a shared child, I can understand its visible relationships without learning the title or content of a private parent or blocker."
      checks={[
        "A locked reference has no private title, destination link, status, or quicklook.",
        "An unavailable markdown mention does not reveal whether the task exists.",
        "I can detach a private blocker after confirmation without opening it.",
      ]}
    >
      <div className="space-y-4">
        {mode === "chips" && (
          <>
            <div>
              <LockedIssueChip identifier="PAP-410" />
            </div>
            <div>
              <LockedIssueChip identifier={null} />
            </div>
            <div>
              <LockedIssueChip identifier="PAP-498" unavailable />
            </div>
          </>
        )}
        {mode === "pills" && (
          <>
            <p className="flex items-center gap-3 text-sm">
              Readable <IssueReferencePill issue={readable} />
            </p>
            <p className="flex items-center gap-3 text-sm">
              Private <IssueReferencePill issue={locked} />
            </p>
            <p className="flex items-center gap-3 text-sm">
              Property variant{" "}
              <IssueReferencePill issue={locked} variant="property" />
            </p>
          </>
        )}
        {mode === "markdown" && (
          <MarkdownBody linkIssueReferences>
            {
              "Read the public research in [PAP-499](/PAP/issues/PAP-499). The original briefing [PAP-498](/PAP/issues/PAP-498) is unavailable to this reader.\n\nBare references are also checked: PAP-499 and PAP-498."
            }
          </MarkdownBody>
        )}
        {(mode === "blocker" || mode === "mixed") && (
          <IssueBlockedNotice
            issueId="privacy-child"
            issueStatus="blocked"
            blockers={
              mode === "mixed" ? [lockedBlocker, readable] : [lockedBlocker]
            }
          />
        )}
        {mode === "remove" &&
          (removed ? (
            <p role="status" className="text-sm">
              Blocker removed. The private task itself is unchanged.
            </p>
          ) : (
            <RemovableIssueReferencePill
              issue={locked}
              isMobile={mobileControl}
              onRemove={() => setRemoved(true)}
            />
          ))}
      </div>
    </StoryFrame>
  );
}
const meta = {
  title: "Private tasks/04 References and blockers",
  decorators: [privacyDecorator],
  parameters: { ...privacyParameters, docs: { description: { component: "Task references, parent navigation and blockers redact unreadable task content. Inspect all existing reference variants and mobile." } } },
  render: () => <References />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const LockedChipVariants: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).queryByRole("link"),
    ).not.toBeInTheDocument();
  },
};
export const ReferencePillVariants: Story = {
  render: () => <References mode="pills" />,
};
export const MarkdownMentions: Story = {
  render: () => <References mode="markdown" />,
};
export const PendingMention: Story = {
  parameters: { privacy: { loading: "mention" } },
  render: () => <References mode="markdown" />,
};
export const PrivateBlocker: Story = {
  render: () => <References mode="blocker" />,
};
export const MixedBlockers: Story = {
  render: () => <References mode="mixed" />,
};
export const RemovablePrivateBlocker: Story = {
  render: () => <References mode="remove" />,
};
export const RemoveBlockerConfirmation: Story = {
  render: () => <References mode="remove" />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Remove PAP-410 as blocker" }),
    );
    await expect(await page.findByRole("dialog")).toHaveTextContent(
      "Remove PAP-410 as a blocker",
    );
  },
};
export const MobileBlockerActions: Story = {
  globals: mobile,
  render: () => <References mode="remove" mobileControl />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Actions for blocker PAP-410" }),
    );
    await expect(
      await page.findByRole("menuitem", { name: "Remove blocker" }),
    ).toBeVisible();
    await expect(
      page.queryByRole("menuitem", { name: "Visit task" }),
    ).not.toBeInTheDocument();
  },
};
export const MobileBlockerConfirmation: Story = {
  globals: mobile,
  render: () => <References mode="remove" mobileControl />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Actions for blocker PAP-410" }),
    );
    await userEvent.click(
      await page.findByRole("menuitem", { name: "Remove blocker" }),
    );
    await expect(await page.findByRole("dialog")).toHaveTextContent(
      "Remove PAP-410 as a blocker",
    );
  },
};
export const LightReferences: Story = {
  globals: { theme: "light" },
  render: () => <References mode="pills" />,
};

export const AncestorNavigation: Story = {
  render: () => (
    <StoryFrame
      title="Ancestor navigation"
      story="As a shared reader, I see locked ancestors without a destination link, alongside any ancestors I can read."
      checks={[
        "Private ancestors have no title, status, or quicklook.",
        "Readable ancestors remain navigable.",
      ]}
    >
      <RelationNavigationList
        items={[locked, readable]}
        emptyMessage="No ancestors"
        ariaLabel="Ancestor tasks"
      />
    </StoryFrame>
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement);
    await expect(page.getByTestId("locked-issue-chip")).toHaveTextContent(
      "PAP-410",
    );
    await expect(page.getAllByRole("link")).toHaveLength(1);
  },
};
