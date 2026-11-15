import { voiceStoryLifecycle } from "../../../support/speko/voiceStoryLifecycle";
import { expect, within } from "storybook/test";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { VoiceTranscript } from "@/components/voice/VoiceTranscript";

const meta = { ...voiceStoryLifecycle,
  id: "connections-speko-transcript", title: "Apps, channels, and extensions/External chat and email/Speko/Transcript", component: VoiceTranscript,
  args: { agentName: "Company Phone Agent", entries: [] }, parameters: { layout: "padded", paperclip: {"capabilities": ["chat-channels/conversation"], "status": "current", "implementation": "production", "boundary": "fixtures", "notes": "Production transcript with fixture partial/final, overlapping, interrupted and long turns. No speech recognition or audio playback proof."} },
} satisfies Meta<typeof VoiceTranscript>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Unavailable: Story = { args: { unavailable: true } };
export const PartialSpeech: Story = { args: { entries: [{ id: "a", source: "user", text: "Could you check the next", final: false }] } };
export const FinalSpeech: Story = { args: { entries: [{ id: "a", source: "user", text: "Could you check the next delivery date?", final: true }] } };
export const OverlappingUpdates: Story = { args: { entries: [
  { id: "a", source: "agent", text: "The order is scheduled for", final: false, interrupted: true },
  { id: "b", source: "user", text: "Please check the revised address too.", final: true },
] }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await expect(canvas.getByText("· Interrupted")).toBeVisible();
  await expect(canvas.queryByText("· Speaking")).not.toBeInTheDocument();
} };
export const DelayedResult: Story = { args: { entries: [
  { id: "a", source: "agent", text: "I’m checking that now.", final: true },
  { id: "notification", source: "application", text: "A task update is available.", final: true },
  { id: "b", source: "agent", text: "The next delivery date is September 18.", final: true },
] } };
export const TaskReference: Story = { args: { entries: [{ id: "a", source: "agent", text: "The changes are recorded in task PAP-42. Open the task to review and approve them.", final: true }] } };
export const LongConversation: Story = { args: { agentName: "Company agent for customer support across international regions", entries: Array.from({ length: 30 }, (_, index) => ({ id: String(index), source: index % 2 ? "agent" as const : "user" as const, text: index % 2 ? "The task is still running. I have added your clarification to the same task and will share its approved answer here." : "Please include the details we discussed earlier and preserve the existing task context.", final: true })) } };
