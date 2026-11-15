import type { Meta, StoryObj } from "@storybook/react-vite";
import { DesktopNotificationsSettings } from "@/components/DesktopNotificationsSettings";
import { DESKTOP_NOTIFICATION_STORAGE_KEY } from "@/lib/desktop-notifications";

const meta = {
  id: "feature-desktop-notifications-settings",
  title: "Oversight and operation/Navigation, profile, and announcements/Desktop notifications",
  component: DesktopNotificationsSettings,
  parameters: {
    layout: "padded",
    paperclip: {
      capabilities: ["navigation-preferences/profile"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Production Profile desktop-notifications control. Permission and Notification API states are simulated only in Vitest; this story renders the live browser permission.",
    },
  },
  beforeEach: () => {
    window.localStorage.setItem(DESKTOP_NOTIFICATION_STORAGE_KEY, "off");
  },
  decorators: [
    (Story) => (
      <main className="p-6">
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof DesktopNotificationsSettings>;
export default meta;
type Story = StoryObj<typeof meta>;
export const OffByDefault: Story = {};
export const NeedsAttentionStored: Story = {
  name: "Needs attention stored",
  beforeEach: () => {
    window.localStorage.setItem(DESKTOP_NOTIFICATION_STORAGE_KEY, "attention");
  },
};
export const AllStored: Story = {
  name: "All stored",
  beforeEach: () => {
    window.localStorage.setItem(DESKTOP_NOTIFICATION_STORAGE_KEY, "all");
  },
};
