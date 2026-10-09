import type { Meta, StoryObj } from "@storybook/react-vite";
import { CloudAccessError } from "@/components/CloudAccessGate";

const meta: Meta<typeof CloudAccessError> = {
  title: "App/Connection recovery",
  component: CloudAccessError,
  parameters: { layout: "fullscreen" },
  args: { temporary: true, retrying: false, onRetry: () => undefined },
};

export default meta;
type Story = StoryObj<typeof CloudAccessError>;

export const WaitingForServer: Story = {};
export const CheckingConnection: Story = { args: { retrying: true } };
export const AccessCheckFailed: Story = { args: { temporary: false } };
