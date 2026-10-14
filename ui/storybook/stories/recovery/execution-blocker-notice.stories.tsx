import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { FileRecoveryApiFixture } from "../../support/workspace-file-recovery/fixture";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExecutionBlockerNotice } from "@/components/ExecutionBlockerNotice";
import { queryKeys } from "@/lib/queryKeys";

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
client.setQueryData(queryKeys.issues.runs("storybook-recovery"), [
  { runId: "stopped-run", agentId: "agent", status: "failed" },
]);
const meta = {
  parameters: { docs: { story: { inline: false } }, paperclip: {
      "capabilities": [
        "recovery/diagnosis"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Retained-file states cover the production repair form, source-bound evidence and unchanged task status; fixture APIs do not prove live provider recovery."
    } },
  id: "task-chat-recovery-notice",
  title: "Projects and execution/Recovery/Task chat/Recovery notice",
  component: ExecutionBlockerNotice,
  decorators: [(Story, context) => <FileRecoveryApiFixture response={context.parameters.fileRecoveryResponse ?? "success"}><QueryClientProvider client={client}><div className="max-w-2xl"><Story /></div></QueryClientProvider></FileRecoveryApiFixture>],
  args: {
    companyId: "storybook-company", issueId: "storybook-recovery", onRetried: () => {},
    blocker: {
      recoveryActionId: "recovery", runId: "stopped-run", agentId: "agent",
      cause: "legacy_execution_requires_reconciliation",
      nextAction: "Automatic recovery stopped. Recorded work is preserved; actions with unverified outcomes will not be repeated.",
    },
  },
} satisfies Meta<typeof ExecutionBlockerNotice>;
export default meta;
export const Stopped: StoryObj<typeof meta> = {};

const fileHold = {
  ...meta.args.blocker,
  nextAction: "Recover and verify files from the retained original workspace before continuing.",
  workspaceRepairRequired: true,
  canRecordWorkspaceRepair: true,
};
export const FileRecovery: StoryObj<typeof meta> = { args: { blocker: fileHold, issueStatus: "in_review", canManage: true } };
export const FileRecoveryReadOnly: StoryObj<typeof meta> = { args: { blocker: fileHold, issueStatus: "in_review", canManage: false } };
export const FileRecoveryRecorded: StoryObj<typeof meta> = {
  args: { blocker: fileHold, issueStatus: "in_review", canManage: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const button = canvas.getByRole("button", { name: "Record file recovery" });
    await expect(button).toBeDisabled();
    await userEvent.type(canvas.getByRole("textbox"), "The original workspace files were recovered into the attached archive and verified against both repository heads.");
    await userEvent.click(canvas.getByRole("checkbox"));
    await userEvent.click(button);
    await expect(await canvas.findByText("File recovery recorded. The task status is unchanged. Continue the task when it is ready.")).toBeVisible();
  },
};
export const FileRecoveryRejected: StoryObj<typeof meta> = {
  args: { blocker: fileHold, issueStatus: "in_review", canManage: true },
  parameters: { fileRecoveryResponse: "conflict" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const evidence = "The original workspace files were recovered into the attached archive and verified against both repository heads.";
    await userEvent.type(canvas.getByRole("textbox"), evidence);
    await userEvent.click(canvas.getByRole("checkbox"));
    await userEvent.click(canvas.getByRole("button", { name: "Record file recovery" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("The original execution is not verified stopped.");
    await expect(canvas.getByRole("textbox")).toHaveValue(evidence);
  },
};
