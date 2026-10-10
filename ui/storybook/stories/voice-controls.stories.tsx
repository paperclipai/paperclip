import { voiceStoryLifecycle } from "../fixtures/voiceStoryLifecycle";
import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { VoiceControls, VOICE_CONTROL_STATES, type VoiceControlState } from "@/components/voice/VoiceControls";

const noop = () => {};
const meta = { ...voiceStoryLifecycle,
  title: "Connections/Speko/Voice controls",
  component: VoiceControls,
  args: { state: "idle", agentName: "Speko Company Phone Agent", onStart: noop, onMute: noop, onEnd: noop, onResumeAudio: noop },
  parameters: { layout: "padded" },
} satisfies Meta<typeof VoiceControls>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Idle: Story = {};
export const Connecting: Story = { args: { state: "connecting" } };
export const Listening: Story = { args: { state: "listening" } };
export const Speaking: Story = { args: { state: "speaking" } };
export const Muted: Story = { args: { state: "listening", muted: true } };
export const Working: Story = { args: { state: "working" } };
export const Interrupted: Story = { args: { state: "interrupted" } };
export const Reconnecting: Story = { args: { state: "reconnecting" } };
export const Ending: Story = { args: { state: "ending" } };
export const CleanupFailed: Story = { args: { state: "cleanup_failed", error: "The call could not be fully closed. Retry ending it before starting another call." } };
export const Ended: Story = { args: { state: "ended" } };
export const Failed: Story = { args: { state: "failed", error: "Speko could not connect. Check your connection and try again." } };
export const MicrophoneDenied: Story = { args: { state: "failed", error: "Microphone access was denied. Allow microphone access in your browser, then try again." } };
export const PlaybackBlocked: Story = { args: { state: "listening", playbackBlocked: true } };
export const LongName: Story = { args: { state: "working", agentName: "Company phone agent for international customer support and implementation scheduling" } };
export const StateMatrix: Story = { render: (args) => <div className="flex flex-col gap-8">{VOICE_CONTROL_STATES.map((state) => <VoiceControls key={state} {...args} state={state} />)}</div> };
function Interactive() {
  const [state, setState] = useState<VoiceControlState>("idle");
  const [muted, setMuted] = useState(false);
  return <VoiceControls state={state} muted={muted} agentName="Company Phone Agent" onStart={() => setState("listening")} onMute={() => setMuted((value) => !value)} onEnd={() => setState("ended")} onResumeAudio={noop} />;
}
export const KeyboardMuteAndEnd: Story = {
  render: () => <Interactive />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const start = canvas.getByRole("button", { name: "Start voice" });
    start.focus(); await userEvent.keyboard("{Enter}");
    const mute = canvas.getByRole("button", { name: "Mute" });
    mute.focus(); await userEvent.keyboard(" ");
    await expect(canvas.getByRole("button", { name: "Unmute" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.tab();
    await expect(canvas.getByRole("button", { name: "End call" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("status")).toHaveTextContent("Call ended");
    await expect(canvas.getByRole("button", { name: "Start voice" })).toHaveFocus();
  },
};

function RepeatFixture() {
  const [announcement, setAnnouncement] = useState("");
  return <VoiceControls state="speaking" agentName="Company Phone Agent" canRepeat announcement={announcement}
    onStart={noop} onMute={noop} onEnd={noop} onResumeAudio={noop} onRepeat={() => setAnnouncement("Repeat requested")} />;
}
export const RepeatAnswer: Story = { render: () => <RepeatFixture />, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement); canvas.getByRole("button", { name: "Repeat answer" }).focus();
  await userEvent.keyboard("{Enter}"); await expect(canvas.getByText("Repeat requested")).toBeInTheDocument();
} };
export const RepeatUnavailableWhileEnding: Story = { args: { state: "ending", canRepeat: true, onRepeat: noop } };
