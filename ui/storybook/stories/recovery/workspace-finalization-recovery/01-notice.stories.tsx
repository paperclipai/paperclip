import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { WorkspaceExportRecovery } from "@/components/WorkspaceExportRecovery";
import { automaticAction, queuedAction, recoveryAction } from "../../../support/workspace-finalization-recovery/fixtures";
const meta = {
  id: "workspace-finalization-recovery-01-notice",
  title: "Projects and execution/Recovery/Workspace finalization recovery/01 Notice",
  component: WorkspaceExportRecovery,
  args: { action: automaticAction },
  parameters: { layout: "fullscreen", docs: { story: { inline: false }, description: { component: "Controller recovery runs in the harness. The task shows a quiet status and removes it when saving finishes. Legacy receipts without platform identity require operator assistance through the documented API; no shutdown form is shown to users." } },
    paperclip: {
      "capabilities": [
        "recovery/workspace",
        "recovery/source-action"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Production quiet status; automatic restoration, legacy operator fallback, queued and resolved states. No task repair form, process details or API simulation. Provider proof is verified by separate server and harness tests."
    },
  },
  decorators: [Story => <div className="mx-auto max-w-2xl p-4 sm:p-8"><Story /></div>],
} satisfies Meta<typeof WorkspaceExportRecovery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const RestoringSavedWork: Story = { play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByRole("status")).toHaveTextContent("Restoring saved work");
  await expect(canvas.queryByRole("button")).not.toBeInTheDocument();
  await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
} };
export const NeedsVerification: Story = { args: { action: recoveryAction } };
export const VerificationUnavailable: Story = { args: { action: {
  ...automaticAction, evidence: { ...automaticAction.evidence, workspaceOwnerRecovery: { state: "operator_required" } },
} }, play: async ({ canvasElement }) => {
  await expect(within(canvasElement).getByRole("status")).toHaveTextContent("operator assistance");
} };
export const AlreadyQueued: Story = { args: { action: queuedAction } };
export const Saved: Story = { args: { action: null } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
