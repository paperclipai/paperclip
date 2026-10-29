import type { Meta, StoryObj } from "@storybook/react-vite";
import { PrimaryPage, mobile, primaryDecorator, primaryParameters } from "../../../support/primary-agent/PrimaryAgentStory";

export default { id: "primary-agent-05-chat",
  title: "Agents and reusable capabilities/Hiring, configuration, and organization/Primary Agent/05 Chat", decorators: [primaryDecorator], parameters: { ...primaryParameters, initialEntries: ["/PAP/chats"],
    paperclip: {
      "capabilities": [
        "agents/primary-agent",
        "tasks/create",
        "agent-chat/discovery"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Primary choice, replacement confirmation, unavailable states and task/chat fallback presentation use local presentation-provider callbacks. Production preference persistence and default-resolution precedence remain unverified by this suite. The filter uses one lowercase label without helper text. All chat-channel tasks count as bot-created; the focused visibility stories cover human-initiated channel work."
    },
  }, render: () => <PrimaryPage /> } satisfies Meta;
type Story = StoryObj;
export const PrimaryFallback: Story = {};
export const RecentConversationWins: Story = { parameters: { primaryAgent: { recentChat: true } } };
export const NoPrimaryChooser: Story = { parameters: { primaryAgent: { primaryId: null } } };
export const PausedPrimary: Story = { parameters: { primaryAgent: { paused: true } } };
export const UnavailablePrimaryChooser: Story = { parameters: { primaryAgent: { unavailable: true } } };
export const MobilePrimary: Story = { globals: mobile };
export const MobileChooser: Story = { ...NoPrimaryChooser, globals: mobile };
export const Light: Story = { globals: { theme: "light" } };
