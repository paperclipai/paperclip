import type { Meta, StoryObj } from "@storybook/react-vite";
import { PrimaryPage, mobile, primaryDecorator, primaryParameters } from "./PrimaryAgentStory";

export default { title: "Primary Agent/05 Chat", decorators: [primaryDecorator], parameters: { ...primaryParameters, initialEntries: ["/PAP/chats"] }, render: () => <PrimaryPage /> } satisfies Meta;
type Story = StoryObj;
export const PrimaryFallback: Story = {};
export const RecentConversationWins: Story = { parameters: { primaryAgent: { recentChat: true } } };
export const NoPrimaryChooser: Story = { parameters: { primaryAgent: { primaryId: null } } };
export const PausedPrimary: Story = { parameters: { primaryAgent: { paused: true } } };
export const UnavailablePrimaryChooser: Story = { parameters: { primaryAgent: { unavailable: true } } };
export const MobilePrimary: Story = { globals: mobile };
export const MobileChooser: Story = { ...NoPrimaryChooser, globals: mobile };
export const Light: Story = { globals: { theme: "light" } };
