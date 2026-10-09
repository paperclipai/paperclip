import type { Meta, StoryObj } from "@storybook/react-vite";
import { SlackAvatarSettingsPreview } from "../prototypes/slack-avatar/SlackAvatarSettingsPreview";
const meta = {
  title: "Connections/Slack/Avatar in Settings",
  component: SlackAvatarSettingsPreview,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The production avatar section in a Settings layout fixture. Download remains available after onboarding; upload instructions expand in place.",
      },
    },
  },
} satisfies Meta<typeof SlackAvatarSettingsPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Settings: Story = {};
