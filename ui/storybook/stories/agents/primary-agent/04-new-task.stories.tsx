import type { Meta, StoryObj } from "@storybook/react-vite";
import { PrimaryPage, mobile, primaryDecorator, primaryParameters } from "../../../support/primary-agent/PrimaryAgentStory";

export default { id: "primary-agent-04-new-task",
  title: "Agents and reusable capabilities/Hiring, configuration, and organization/Primary Agent/04 New task", decorators: [primaryDecorator], parameters: { ...primaryParameters, paperclip: {
      "capabilities": [
        "agents/primary-agent",
        "tasks/create",
        "agent-chat/discovery"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Primary choice, replacement confirmation, unavailable states and task/chat fallback presentation use local presentation-provider callbacks. Production preference persistence and default-resolution precedence remain unverified by this suite. The filter uses one lowercase label without helper text. All chat-channel tasks count as bot-created; the focused visibility stories cover human-initiated channel work."
    } }, render: () => <PrimaryPage task="primary" /> } satisfies Meta;
type Story = StoryObj;
export const PrimaryFallback: Story = {};
export const RecentSpecialistWins: Story = { parameters: { primaryAgent: { recentAssignee: true } }, render: () => <PrimaryPage task="recent" /> };
export const ExplicitAssignmentWins: Story = { parameters: { primaryAgent: { recentAssignee: true } }, render: () => <PrimaryPage task="explicit" /> };
export const RestoredDraftWins: Story = { parameters: { primaryAgent: { recentAssignee: true } }, render: () => <PrimaryPage task="draft" /> };
export const NoPrimary: Story = { parameters: { primaryAgent: { primaryId: null } } };
export const UnavailablePrimary: Story = { parameters: { primaryAgent: { unavailable: true } } };
export const PausedPrimary: Story = { parameters: { primaryAgent: { paused: true } } };
export const MobilePrimary: Story = { globals: mobile };
export const MobileDraft: Story = { ...RestoredDraftWins, globals: mobile };
