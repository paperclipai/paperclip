import type { Meta, StoryObj } from "@storybook/react-vite";
import type { AgentSetupProgress, AgentSetupProgressItem } from "@paperclipai/shared";
import { AgentSetupProgressPanel } from "@/components/AgentSetupProgress";

const at = (status: AgentSetupProgress["status"], items: AgentSetupProgressItem[], summary: string | null = null): AgentSetupProgress => ({
  id: "7d1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b", companyId: "company-storybook", purpose: "aws_connection", subjectId: null,
  status, items, summary, expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  createdAt: new Date(Date.now() - 60_000).toISOString(), updatedAt: new Date(Date.now() - 5_000).toISOString(),
});
const item = (key: string, title: string, status: AgentSetupProgressItem["status"], detail: string | null = null) => ({ key, title, status, detail });

const meta = {
  id: "connection-setup-agent-setup-progress",
  title: "Apps, channels, and extensions/Connection setup/Apps/Connections/Agent setup progress",
  component: AgentSetupProgressPanel,
  parameters: { layout: "padded", paperclip: { implementation: "production", boundary: "fixtures",
    capabilities: ["connection-setup/credentials"],
    notes: "Production live checklist a person's own agent fills in during Set it up with your agent, with synthetic progress. Reusable by any setup prompt." } },
  decorators: [(Story) => <div className="mx-auto max-w-xl"><Story /></div>],
  args: { subject: "AWS", progress: at("waiting", []) },
} satisfies Meta<typeof AgentSetupProgressPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Waiting: Story = {};
export const Working: Story = {
  args: { progress: at("in_progress", [
    item("connect", "Connect agent", "done", "Signed in through the AWS CLI."),
    item("analyze", "Check the AWS account", "done", "Account 123456789012."),
    item("deploy", "Create the role", "in_progress", "Deploying the CloudFormation stack."),
    item("report", "Report the role ARN", "pending"),
  ]) },
};
export const Done: Story = {
  args: { progress: at("done", [
    item("analyze", "Check the AWS account", "done"),
    item("deploy", "Create the role", "done", "Stack created."),
    item("report", "Report the role ARN", "done"),
  ], "Role ARN: arn:aws:iam::123456789012:role/paperclip-7d1f2a3b") },
};
export const Failed: Story = {
  args: { progress: at("failed", [
    item("analyze", "Check the AWS account", "done"),
    item("deploy", "Create the role", "failed", "This identity cannot create IAM roles."),
  ], "Stopped: sign in as an administrator and run the prompt again.") },
};
