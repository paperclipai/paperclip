import { useEffect, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { NewIssueDialog } from "@/components/NewIssueDialog";
import { useDialog } from "@/context/DialogContext";
import { Button } from "@/components/ui/button";
import {
  mobile,
  privacyDecorator,
  privacyParameters,
  StoryFrame,
} from "./PrivacyStory";

function Creation({
  parent = false,
  project = false,
  draft = false,
}: {
  parent?: boolean;
  project?: boolean;
  draft?: boolean;
}) {
  const { openNewIssue } = useDialog();
  const opened = useRef(false);
  const open = () =>
    openNewIssue({
      ...(draft
        ? {}
        : {
            title: parent
              ? "Research market benchmarks"
              : "Prepare my board briefing",
          }),
      ...(parent
        ? {
            parentId: "privacy-root",
            parentIdentifier: "PAP-410",
            parentTitle: "Prepare my board briefing",
          }
        : {}),
      ...(project ? { projectId: "project-private" } : {}),
    });
  useEffect(() => {
    if (!opened.current) {
      opened.current = true;
      open();
    }
  }, []);
  return (
    <StoryFrame
      title={parent ? "Create a private subtask" : "Choose the task audience"}
      story="As a CEO, I can mark a task private before saving. New children of a private task inherit its restrictions even when another agent does the work."
      checks={[
        "New company tasks start open. The Private task switch is an explicit choice.",
        "A private parent's child starts private and the switch cannot be turned off.",
        "Selecting a private project and restoring a saved private draft retain privacy.",
      ]}
    >
      <Button onClick={open}>Create another task</Button>
      <NewIssueDialog />
    </StoryFrame>
  );
}
const meta = {
  title: "Private tasks/01 Creation",
  decorators: [privacyDecorator],
  parameters: privacyParameters,
  render: () => <Creation />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const OpenByDefault: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement.ownerDocument.body).findByRole("switch", {
        name: "Private task",
      }),
    ).not.toBeChecked();
  },
};
export const PrivateBeforeSaving: Story = {
  play: async ({ canvasElement }) => {
    const toggle = await within(canvasElement.ownerDocument.body).findByRole(
      "switch",
      { name: "Private task" },
    );
    await userEvent.click(toggle);
    await expect(toggle).toBeChecked();
  },
};
export const ChildInheritsPrivacy: Story = {
  render: () => <Creation parent />,
  play: async ({ canvasElement }) => {
    const toggle = await within(canvasElement.ownerDocument.body).findByRole(
      "switch",
      { name: "Private task" },
    );
    await waitFor(() => expect(toggle).toBeChecked());
    await expect(toggle).toBeDisabled();
  },
};
export const PrivateProject: Story = { render: () => <Creation project /> };
export const PersonalProject: Story = {
  parameters: { privacy: { personal: true } },
  render: () => <Creation project />,
};
export const RestoredPrivateDraft: Story = {
  parameters: { privacy: { draft: true } },
  render: () => <Creation draft />,
};
export const CreationFailure: Story = {
  parameters: { privacy: { failure: "create", draft: true } },
  render: () => <Creation draft />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(
      await page.findByRole("button", { name: "Create Task" }),
    );
    await expect(
      await page.findByText("The request could not be completed. Try again."),
    ).toBeVisible();
  },
};
export const MobilePrivateChild: Story = {
  globals: mobile,
  render: () => <Creation parent />,
};
export const LightPrivateDraft: Story = {
  globals: { theme: "light" },
  parameters: { privacy: { draft: true } },
  render: () => <Creation draft />,
};
