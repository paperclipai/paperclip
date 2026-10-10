import { voiceStoryLifecycle } from "../fixtures/voiceStoryLifecycle";
import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { VoiceConversationPanel } from "@/components/voice/VoiceConversationPanel";
import type { VoiceSessionDependencies } from "@/lib/voice-session-controller";

function Fixture({ failConnection = false, failCleanup = false }: { failConnection?: boolean; failCleanup?: boolean }) {
  const dependencies = useMemo<VoiceSessionDependencies>(() => {
    let attempts = 0, endings = 0;
    return {
      async mint() { if (failConnection && attempts++ === 0) throw new Error("Synthetic connection failure"); return { sessionId: "storybook-session", generation: 1, transportToken: "fixture-only", transportUrl: "wss://example.invalid" }; },
      async end() { if (failCleanup && endings++ === 0) throw new Error("Synthetic hangup failure"); },
      async connect(_credentials, callbacks) {
        callbacks.onMessage({ source: "agent", segmentId: "ack", text: "I’ll work on that.", isFinal: true });
        return { async endSession() {}, async setMicMuted() {}, async startAudioPlayback() {}, async sendChatMessage() {} };
      },
    };
  }, [failConnection, failCleanup]);
  return <VoiceConversationPanel agentName="Company Phone Agent" dependencies={dependencies} />;
}
const meta: Meta<typeof VoiceConversationPanel> = { ...voiceStoryLifecycle, title: "Connections/Speko/Conversation", component: VoiceConversationPanel, parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj<typeof meta>;
export const Idle: Story = { render: () => <Fixture /> };
export const Connected: Story = {
  render: () => <Fixture />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Start voice" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Mute" })).toBeEnabled());
    await expect(canvas.getByRole("list", { name: "Conversation transcript" })).toHaveTextContent("I’ll work on that.");
  },
};
export const ConnectionRecovery: Story = {
  render: () => <Fixture failConnection />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Start voice" }));
    await waitFor(() => expect(canvas.getByRole("alert")).toHaveTextContent("Voice could not connect"));
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Mute" })).toBeEnabled());
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
  },
};
export const CleanupRecovery: Story = {
  render: () => <Fixture failCleanup />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Start voice" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Mute" })).toBeEnabled());
    await userEvent.click(canvas.getByRole("button", { name: "End call" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Retry ending call" })).toBeEnabled());
    await expect(canvas.queryByRole("button", { name: "Start voice" })).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Retry ending call" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Start voice" })).toHaveFocus());
    await expect(canvas.getByRole("status")).toHaveTextContent("Call ended");
  },
};
