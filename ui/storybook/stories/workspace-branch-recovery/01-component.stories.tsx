import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { WorkspaceBaseRefRecoveryNotice } from "@/components/WorkspaceBaseRefRecoveryNotice";
import { evidence, simulateRepair } from "./fixtures";

const meta = {
  title: "Workspace branch recovery/01 Repair card",
  component: WorkspaceBaseRefRecoveryNotice,
  args: { ...evidence, onRepair: simulateRepair },
  parameters: { layout: "fullscreen", docs: { description: { component: "Proposed inline repair using the reusable component. Repository data and save/retry responses are simulated here; this story does not change a live task. The default-branch action appears only with a verified repository default." } } },
  render: (args, context) => <div className="mx-auto max-w-2xl p-4 sm:p-8"><WorkspaceBaseRefRecoveryNotice key={context.id} {...args} /></div>,
} satisfies Meta<typeof WorkspaceBaseRefRecoveryNotice>;
export default meta;
type Story = StoryObj<typeof meta>;
export const MissingBranch: Story = {};
export const CustomBranch: Story = { play: async ({ canvasElement }) => { await userEvent.click(within(canvasElement).getByRole("button", { name: "Choose another branch" })); } };
export const Saving: Story = { args: { onRepair: () => new Promise<void>(() => {}) }, play: async ({ canvasElement }) => { await userEvent.click(within(canvasElement).getByRole("button", { name: "Use master & retry" })); } };
export const RepairFailed: Story = { args: { onRepair: async () => { throw new Error("Repository access could not be confirmed. Check its GitHub connection, then try again."); } }, play: async ({ canvasElement }) => { await userEvent.click(within(canvasElement).getByRole("button", { name: "Use master & retry" })); } };
export const RetryRequested: Story = { play: async ({ canvasElement }) => { const c = within(canvasElement); await userEvent.click(c.getByRole("button", { name: "Use master & retry" })); await expect(await c.findByText("Branch updated · retry requested")).toBeVisible(); } };
export const UnknownDefault: Story = { args: { defaultBranch: null, failureKind: "unresolved_ref", configuredBy: null } };
export const NoPermission: Story = { args: { unavailableReason: "Only a workspace operator can change this task’s starting branch." } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
