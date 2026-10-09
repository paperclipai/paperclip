import type { Meta, StoryObj } from "@storybook/react-vite";
import { CloudAccessError } from "@/components/CloudAccessGate";
import { ConnectionStatusMessage } from "@/components/ConnectionStatusBanner";

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

/** The app-level banner shown over an open board. */
export const BannerReconnecting: Story = {
  render: () => <ConnectionStatusMessage view="reconnecting" />,
};
export const BannerReconnectingWithPendingWrites: Story = {
  render: () => <ConnectionStatusMessage view="reconnecting" pendingWrites={2} />,
};
export const BannerOffline: Story = {
  render: () => <ConnectionStatusMessage view="offline" />,
};
export const BannerBackOnline: Story = {
  render: () => <ConnectionStatusMessage view="back_online" />,
};
