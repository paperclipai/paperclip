import type { Meta, StoryObj } from "@storybook/react-vite";
import { CloudAccessError } from "@/components/CloudAccessGate";

const meta: Meta<typeof CloudAccessError> = {
  id: "app-connection-recovery",
  title: "Projects and execution/Recovery/App/Connection recovery",
  component: CloudAccessError,
  parameters: { layout: "fullscreen",
    paperclip: {
      "capabilities": [
        "recovery/reconnect"
      ],
      "implementation": "production",
      "boundary": "fixtures"
    },
  },
  args: { temporary: true, retrying: false, onRetry: () => undefined },
};

export default meta;
type Story = StoryObj<typeof CloudAccessError>;

export const WaitingForServer: Story = {};
export const CheckingConnection: Story = { args: { retrying: true } };
export const AccessCheckFailed: Story = { args: { temporary: false } };
