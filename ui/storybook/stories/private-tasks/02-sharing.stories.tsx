import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { IssueShareSheet } from "@/components/IssueShareSheet";
import { Button } from "@/components/ui/button";
import { privacyCompanyId } from "../../fixtures/privateTasks";
import {
  mobile,
  privacyDecorator,
  privacyParameters,
  StoryFrame,
  usePrivacyStory,
} from "./PrivacyStory";

function Sharing({
  add = "",
  implicit = false,
  child = false,
}: {
  add?: string;
  implicit?: boolean;
  child?: boolean;
}) {
  const state = usePrivacyStory();
  const [open, setOpen] = useState(true);
  return (
    <StoryFrame
      title={
        child ? "Share only the research subtask" : "Who can access this task"
      }
      story={
        child
          ? "As the CEO, I share a research subtask with Morgan while keeping its parent briefing and sibling compensation task private."
          : "As the owner, I can inspect why each person or agent has access, share the task, or remove a saved grant."
      }
      checks={[
        "Owner, explicit, assignment, and project grants have distinct source badges.",
        "Inherited access is managed at its source. Removing one saved grant does not cancel other access.",
        "A child grant includes that child's descendants; it gives no access to ancestors or siblings.",
      ]}
    >
      <Button onClick={() => setOpen(true)}>Open sharing</Button>
      <IssueShareSheet
        issueId={child ? "privacy-child" : "privacy-root"}
        companyId={privacyCompanyId}
        canManage={state.options.role !== "reader"}
        open={open}
        onOpenChange={setOpen}
        initialView={add ? "add" : "list"}
        initialAddSelection={add === "choose" ? "" : add}
        implicitPrincipals={
          implicit
            ? [
                {
                  id: "user:user-board",
                  displayName: "Avery Chen",
                  roleLabel: "Owner",
                },
                {
                  id: "agent:agent-dedicated",
                  displayName: "Executive assistant",
                  roleLabel: "Current assignee",
                },
              ]
            : []
        }
      />
    </StoryFrame>
  );
}
const meta = {
  title: "Private tasks/02 Sharing",
  decorators: [privacyDecorator],
  parameters: privacyParameters,
  render: () => <Sharing />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const AllAccessSources: Story = {};
export const OwnerAndCurrentAssignee: Story = {
  render: () => <Sharing implicit />,
};
export const OnlyYou: Story = { parameters: { privacy: { grants: "empty" } } };
export const ReadOnlyMember: Story = {
  parameters: { privacy: { role: "reader" } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await page.findByText("Morgan Reed");
    await expect(
      page.queryByRole("button", { name: "Add someone" }),
    ).not.toBeInTheDocument();
    await expect(
      page.queryByRole("button", { name: "Revoke" }),
    ).not.toBeInTheDocument();
  },
};
export const InheritedAccess: Story = {
  parameters: { privacy: { grants: "inherited" } },
};
export const StickyAssignmentAfterUnassignment: Story = {
  parameters: { privacy: { grants: "assignment" } },
};
export const RemoveCurrentAssigneesSavedGrant: Story = {
  parameters: { privacy: { grants: "assignment" } },
  render: () => <Sharing implicit />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Remove saved grant" }),
    );
    await expect(await page.findByRole("alertdialog")).toHaveTextContent(
      "current assignment",
    );
  },
};
export const RevokeConfirmation: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      (await page.findAllByRole("button", { name: "Revoke" }))[0]!,
    );
    await expect(await page.findByRole("alertdialog")).toHaveTextContent(
      "descendants",
    );
  },
};
export const RevokeFailure: Story = {
  parameters: { privacy: { failure: "revoke" } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      (await page.findAllByRole("button", { name: "Revoke" }))[0]!,
    );
    await userEvent.click(
      await page.findByRole("button", { name: "Remove grant" }),
    );
    await expect(await page.findByRole("alertdialog")).toBeVisible();
  },
};
export const ChoosePersonOrAgent: Story = {
  parameters: { privacy: { grants: "empty" } },
  render: () => <Sharing add="choose" />,
};
export const ShareChildWithPerson: Story = {
  parameters: { privacy: { grants: "empty" } },
  render: () => <Sharing add="user:user-product" child />,
};
export const DedicatedAgent: Story = {
  parameters: { privacy: { grants: "empty" } },
  render: () => <Sharing add="agent:agent-dedicated" />,
};
export const SharedAgentCaution: Story = {
  parameters: { privacy: { grants: "empty" } },
  render: () => <Sharing add="agent:agent-shared" />,
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole("note", {
        name: "Shared agent caution",
      }),
    ).toHaveTextContent("residual private context");
  },
};
export const LegacyAgentCaution: Story = {
  parameters: { privacy: { grants: "empty" } },
  render: () => <Sharing add="agent:agent-unspecified" />,
};
export const AddFailure: Story = {
  parameters: { privacy: { grants: "empty", failure: "add" } },
  render: () => <Sharing add="user:user-product" />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(await page.findByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(page.getByText("Couldn't add access")).toBeVisible(),
    );
  },
};
export const Loading: Story = {
  parameters: { privacy: { loading: "grants" } },
};
export const LoadFailure: Story = {
  parameters: { privacy: { failure: "grants" } },
};
export const RetryRecovers: Story = {
  parameters: { privacy: { failure: "grants", retryOnce: true } },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("button", { name: "Retry" }));
    await expect(await page.findByText("Morgan Reed")).toBeVisible();
  },
};
export const LongNamesMobile: Story = {
  globals: mobile,
  parameters: { privacy: { grants: "long" } },
};
export const MobileSharing: Story = { globals: mobile };
export const LightSharing: Story = { globals: { theme: "light" } };
