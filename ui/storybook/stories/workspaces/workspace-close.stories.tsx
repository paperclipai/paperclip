import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ExecutionWorkspaceCloseDialog } from "@/components/ExecutionWorkspaceCloseDialog";
import { ToastViewport } from "@/components/ToastViewport";
import {
  prepareFixtureApi,
  type FixtureState,
} from "../../support/capability-gaps/api";
function CloseWorkspace() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <ExecutionWorkspaceCloseDialog
        workspaceId="workspace-gap"
        workspaceName="Feature review checkout"
        currentStatus="active"
        open={open}
        onOpenChange={setOpen}
      />
      <ToastViewport />
    </>
  );
}
const meta = {
  id: "feature-workspace-close",
  title:
    "Projects and execution/Workspaces, services, and files/Close readiness",
  component: CloseWorkspace,
  parameters: { layout: "padded",
    paperclip: {
      "capabilities": [
        "workspaces/closure"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Readiness dialog with loading, inspection failure/403, running-task block and pending/accepted archive response. No real workspace cleanup, Git removal or service shutdown is performed."
    },
  },
  beforeEach: ({ parameters }) =>
    prepareFixtureApi(
      [
        {
          path: "/api/execution-workspaces/workspace-gap/close-readiness",
          read: () => ({
            workspaceId: "workspace-gap",
            deliveryState: "unknown",
            isDestructiveCloseAllowed: !parameters.blocked,
            state: parameters.blocked ? "blocked" : "ready",
            linkedIssues: [],
            blockingReasons: parameters.blocked
              ? ["A task is still running in this workspace."]
              : [],
            warnings: [],
            runtimeServices: [],
            plannedActions: [],
            isSharedWorkspace: false,
            isProjectPrimaryWorkspace: false,
            git: null,
          }),
        },
        {
          path: "/api/execution-workspaces/workspace-gap",
          method: "PATCH",
          read: ({ body }) => ({
            id: "workspace-gap",
            companyId: "company-storybook",
            name: "Feature review checkout",
            ...body,
          }),
        },
      ],
      parameters.fixtureState as FixtureState,
    ).cleanup,
} satisfies Meta<typeof CloseWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ready: Story = {
  play: async () => {
    await within(document.body).findByText("Close is ready");
  },
};
export const Loading: Story = {
  parameters: { fixtureState: "loading" },
  play: async () => {
    await within(document.body).findByText(
      "Checking whether this workspace is safe to close...",
    );
  },
};
export const FailedInspection: Story = {
  parameters: { fixtureState: "failure" },
  play: async () => {
    await within(document.body).findByText(
      "The request failed. Please try again.",
    );
  },
};
export const PermissionDenied: Story = {
  parameters: { fixtureState: "permission" },
  play: async () => {
    await within(document.body).findByText(
      "You do not have permission to perform this action.",
    );
  },
};
export const BlockedByRunningTask: Story = {
  parameters: { blocked: true },
  play: async () => {
    const c = within(document.body);
    await c.findByText("Close is blocked");
    await expect(
      c.getByRole("button", { name: "Close workspace" }),
    ).toBeDisabled();
  },
};
export const Closing: Story = {
  parameters: { fixtureState: "saving" },
  play: async () => {
    const c = within(document.body);
    await c.findByText("Close is ready");
    await userEvent.click(c.getByRole("button", { name: "Close workspace" }));
    await expect(
      c.getByRole("button", { name: "Close workspace" }),
    ).toBeDisabled();
  },
};
export const Closed: Story = {
  play: async () => {
    const c = within(document.body);
    await c.findByText("Close is ready");
    await userEvent.click(c.getByRole("button", { name: "Close workspace" }));
    await c.findByText("Workspace closed");
    await expect(c.queryByRole("dialog")).not.toBeInTheDocument();
  },
};
