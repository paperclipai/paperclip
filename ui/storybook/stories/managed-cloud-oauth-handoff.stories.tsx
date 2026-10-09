import type { Meta, StoryObj } from "@storybook/react-vite";
import { ManagedOAuthHandoffState } from "@/pages/apps/PaperclipCloudOAuthHandoff";

const meta: Meta<typeof ManagedOAuthHandoffState> = {
  title: "Apps/Managed Cloud OAuth handoff",
  component: ManagedOAuthHandoffState,
  parameters: { layout: "fullscreen" },
  args: {
    onRetry: () => undefined,
    onCancel: () => undefined,
  },
};

export default meta;
type Story = StoryObj<typeof ManagedOAuthHandoffState>;

export const PreparingProvider: Story = {
  args: { phase: "loading" },
};

export const ResumingAfterReauthentication: Story = {
  args: { phase: "reauthenticating" },
};

export const RetryAfterInfrastructureFailure: Story = {
  args: {
    phase: "error",
    error: "Paperclip Cloud couldn’t prepare secure sign-in. Try again.",
  },
};

export const TerminalExpiredSession: Story = {
  args: {
    phase: "error",
    error: "This sign-in expired. Return to Paperclip and start the connection again.",
  },
};
