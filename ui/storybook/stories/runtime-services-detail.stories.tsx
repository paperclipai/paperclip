import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { RuntimeServicesReview } from "../prototypes/RuntimeServicesReview";

const meta = {
  title: "Runtime Services/03 Service details and controls",
  component: RuntimeServicesReview,
  parameters: { layout: "fullscreen", docs: { description: { component: "Full production RuntimeServiceDetail page. Covers RuntimeServiceControls and logs, RuntimeServicePolicyEditor, RuntimeServiceEnvironmentEditor and the shared EnvironmentVariablesEditor/row, RuntimeServiceSharing, RuntimeServiceStorage, RuntimeServiceDataDeletion, RuntimeServiceTaskWorkspace/Detach and SearchableSelect. Editors are opened by actual clicks. Actions use a stateful, local API simulation, including delayed, failed and lost-response scenarios." } } },
  args: { page: "detail", scenario: "ready" },
  decorators: [(Story, context) => <Story key={context.id} />],
} satisfies Meta<typeof RuntimeServicesReview>;
export default meta;
type Story = StoryObj<typeof meta>;
const click = (name: string) => async ({ canvasElement }: { canvasElement: HTMLElement }) => { await userEvent.click(await within(canvasElement).findByRole("button", { name })); };

export const Running: Story = {};
export const Starting: Story = { args: { scenario: "starting" } };
export const Stopping: Story = { args: { scenario: "stopping" } };
export const Sleeping: Story = { args: { scenario: "sleeping" } };
export const Stopped: Story = { args: { scenario: "stopped" } };
export const FailedWithRetryAndLogs: Story = { args: { scenario: "failed" }, play: click("Logs") };
export const BackgroundWorker: Story = { args: { scenario: "worker" } };
export const PreviewUnavailable: Story = { args: { scenario: "exposure-error" } };
export const RetentionUncertain: Story = { args: { scenario: "retention-error" } };
export const Viewer: Story = { args: { scenario: "viewer" } };
export const Logs: Story = { play: click("Logs") };
export const LogsUnavailable: Story = { args: { scenario: "logs-error" }, play: click("Logs") };
export const LifetimeEditor: Story = { play: click("Edit lifetime") };
export const CompanyPolicyConflict: Story = { args: { scenario: "conflict" }, play: async (context) => { await click("Edit lifetime")(context); await click("Save lifetime")(context); await expect(await within(context.canvasElement).findByRole("button", { name: "Load current lifetime" })).toBeVisible(); } };
export const ConfigureEnvironment: Story = { args: { scenario: "stopped" }, play: click("Configure environment") };
export const EnvironmentLockedWhileRunning: Story = { play: click("Configure environment") };
export const SharePreview: Story = { play: click("Share preview") };
export const ShareCreated: Story = { play: async (context) => { await click("Share preview")(context); await click("Create share link")(context); await expect(await within(context.canvasElement).findByRole("button", { name: "Revoke link" })).toBeVisible(); } };
export const DevelopInTask: Story = { play: click("Develop in a task") };
export const AttachedTask: Story = { args: { scenario: "attached" } };
export const ProtectedDataRetention: Story = { args: { scenario: "expiration" } };
export const DataDeletionNeedsAttention: Story = { args: { scenario: "deletion" } };
export const ReviewDataDeletion: Story = { args: { scenario: "stopped" }, play: click("Review data deletion") };
export const DeletionBlockedByRunningService: Story = { play: click("Review data deletion") };
export const LostStopResponse: Story = { args: { scenario: "lost-response" }, play: async (context) => { await click("Stop")(context); await expect(await within(context.canvasElement).findByRole("button", { name: "Retry same request" })).toBeVisible(); } };
export const SlowControls: Story = { args: { scenario: "slow" }, parameters: { docs: { description: { story: "Press Stop or Restart to inspect pending feedback. Each simulated write takes five seconds." } } } };
export const Mobile: Story = { globals: { viewport: { value: "mobile" } } };
export const Light: Story = { globals: { theme: "light" } };
