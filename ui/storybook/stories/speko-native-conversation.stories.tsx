import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { VoiceSession } from "@paperclipai/shared";
import { voiceCallJournal } from "@/lib/voice-call-attempt";
import { ApiError } from "@/api/client";
import { Button } from "@/components/ui/button";
import { NativeVoiceConversation } from "@/components/voice/NativeVoiceConversation";
import type { voiceSessionsApi } from "@/api/voiceSessions";
import type { connectSpekoVoiceMedia } from "@/lib/speko-voice-media";
import { voiceStoryLifecycle } from "../fixtures/voiceStoryLifecycle";
const session: VoiceSession = { id: "fixture-session", companyId: "company-storybook", endpointId: "fixture-endpoint", issueId: "fixture-task", assignedAgentId: "agent-codex", state: "active", mode: "browser", generation: 1, callerAuthority: "member", replyCursor: 0, createdAt: "2026-09-12T12:00:00Z", expiresAt: "2026-09-12T12:10:00Z", endedAt: null, errorCode: null };
function Fixture({ creditsRequired = false, notificationsFail = false, accessRevoked = false, unknownCreation = false, cleanupPending = false, interruptedHint = false, agentEntry = false, recovered = false, partialReply = false }: { creditsRequired?: boolean; notificationsFail?: boolean; accessRevoked?: boolean; unknownCreation?: boolean; cleanupPending?: boolean; interruptedHint?: boolean; agentEntry?: boolean; recovered?: boolean; partialReply?: boolean }) {
  const [hintCount, setHintCount] = useState(0);
  const fixture = useMemo(() => {
    let endCount = 0, hints = 0, notifications = 0;
    const client: typeof voiceSessionsApi = {
      async start() { if (creditsRequired) throw new ApiError("Speko needs credits", 409, {details: {code: "voice_credits_required", sessionId: session.id}}); return { session, ...(unknownCreation ? {} : { media: { sessionId: session.id, generation: 1, transportToken: "fixture-only", transportUrl: "wss://fixture.invalid" } }) }; },
      async get() { return session; },
      async end() { return { ...session, state: cleanupPending && endCount++ === 0 ? "ending" : "ended" }; },
      async notification() { if (accessRevoked) throw new ApiError("Access revoked", 403, null); if (notificationsFail) throw new Error("Synthetic outage"); return { sessionId: session.id, generation: 1, publicationId: "fixture-result", attempt: interruptedHint ? notifications++ : 0 }; },
    };
    let finish = () => {};
    const connect: typeof connectSpekoVoiceMedia = async (_credentials, callbacks) => {
      callbacks.onMessage({ source: "agent", segmentId: "ack", text: "I’ll compare those options.", isFinal: !partialReply });
      finish = () => callbacks.onMessage({ source: "agent", segmentId: "ack", text: "I’ll compare those options.", isFinal: true });
      return { async endSession() {}, async setMicMuted() {}, async startAudioPlayback() {}, async sendChatMessage() { setHintCount(n => n + 1); if (interruptedHint && hints++ === 0) { callbacks.onModeChange("speaking"); callbacks.onModeChange("listening"); return; } callbacks.onMessage({ source: "agent", segmentId: "result", text: "The comparison is ready. The second option arrives on Friday.", isFinal: true }); } };
    };
    const values = new Map<string, string>();
    const journal = voiceCallJournal({ getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } }, "company-storybook", "operator");
    if (recovered) journal.write({ request: { endpointId: "fixture-endpoint", idempotencyKey: "saved-attempt" }, sessionId: session.id });
    return { client, connect, finish: () => finish(), ...(recovered ? { journal } : {}) };
  }, [creditsRequired, notificationsFail, accessRevoked, unknownCreation, cleanupPending, interruptedHint, recovered, partialReply]);
  return <><NativeVoiceConversation companyId="company-storybook" endpointId="fixture-endpoint" issueId={agentEntry ? undefined : "fixture-task"} agentName="Company Phone Agent" {...fixture} />{partialReply && <><Button onClick={fixture.finish}>Finish spoken answer</Button><p data-testid="hint-count">Hints: {hintCount}</p></>}</>;
}
const meta: Meta<typeof NativeVoiceConversation> = { ...voiceStoryLifecycle, title: "Connections/Speko/Native conversation", component: NativeVoiceConversation, parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj<typeof meta>;
const start: NonNullable<Story["play"]> = async ({ canvasElement }) => { const canvas = within(canvasElement); await userEvent.click(canvas.getByRole("button", { name: "Start voice" })); await waitFor(() => expect(canvas.getByRole("button", { name: "Mute" })).toBeEnabled()); };
export const Idle: Story = { render: () => <Fixture /> };
export const DelayedResult: Story = { render: () => <Fixture />, play: async (context) => { await start(context); await waitFor(() => expect(within(context.canvasElement).getByRole("list", { name: "Conversation transcript" })).toHaveTextContent("comparison is ready"), { timeout: 15_000 }); } };
export const NotificationUnavailable: Story = { render: () => <Fixture notificationsFail />, play: async (context) => { await start(context); await waitFor(() => expect(within(context.canvasElement).getByRole("alert")).toHaveTextContent("Task updates are temporarily unavailable")); } };
export const Muted: Story = { render: () => <Fixture />, play: async (context) => { await start(context); const canvas = within(context.canvasElement); await userEvent.click(canvas.getByRole("button", { name: "Mute" })); await waitFor(() => expect(canvas.getByRole("button", { name: "Unmute" })).toBeEnabled()); } };
export const Ended: Story = { render: () => <Fixture />, play: async (context) => { await start(context); const canvas = within(context.canvasElement); await userEvent.click(canvas.getByRole("button", { name: "End call" })); await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Call ended")); } };
export const CreationRecovery: Story = { render: () => <Fixture unknownCreation />, play: async ({ canvasElement }) => { const canvas = within(canvasElement); await userEvent.click(canvas.getByRole("button", { name: "Start voice" })); await waitFor(() => expect(canvas.getByRole("button", { name: "Try again" })).toBeEnabled()); } };
export const PendingHangup: Story = { render: () => <Fixture cleanupPending />, play: async (context) => { await start(context); const canvas = within(context.canvasElement); await userEvent.click(canvas.getByRole("button", { name: "End call" })); await waitFor(() => expect(canvas.getByRole("button", { name: "Retry ending call" })).toBeEnabled()); } };

export const InterruptedHintRecovery: Story = { render: () => <Fixture interruptedHint />, play: DelayedResult.play };

export const ContinueConversation: Story = { render: () => <Fixture agentEntry />, play: async (context) => {
  const canvas = within(context.canvasElement);
  await expect(canvas.getByRole("combobox", { name: "Conversation" })).toHaveValue("continue");
  await start(context);
  await expect(canvas.getByRole("link", { name: "View conversation task" })).toHaveAttribute("href", "/issues/fixture-task");
} };
export const NewConversation: Story = { render: () => <Fixture agentEntry />, play: async (context) => {
  const canvas = within(context.canvasElement);
  await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Conversation" }), "new");
  await start(context);
  await userEvent.click(canvas.getByRole("button", { name: "End call" }));
  await waitFor(() => expect(canvas.getByRole("combobox", { name: "Conversation" })).toHaveValue("continue"));
} };

export const AccessRevoked: Story = { render: () => <Fixture accessRevoked />, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Start voice" }));
  await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Call ended"));
  await expect(canvas.getByRole("alert")).toHaveTextContent("Access to this call is no longer available");
} };

export const ReloadRecovery: Story = { render: () => <Fixture recovered />, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Start voice" }));
  await waitFor(() => expect(canvas.getByRole("alert")).toHaveTextContent("previous call was closed"));
  await userEvent.click(canvas.getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(canvas.getByRole("button", { name: "Mute" })).toBeEnabled());
} };

export const PauseWithinSpokenAnswer: Story = { render: () => <Fixture partialReply />, play: async context => {
  await start(context); const canvas = within(context.canvasElement);
  await expect(canvas.getByTestId("hint-count")).toHaveTextContent("Hints: 0");
  await expect(canvas.getByRole("list", { name: "Conversation transcript" })).toHaveTextContent("Speaking");
  await userEvent.click(canvas.getByRole("button", { name: "Finish spoken answer" }));
  await waitFor(() => expect(canvas.getByTestId("hint-count")).toHaveTextContent("Hints: 1"), { timeout: 15_000 });
  await expect(canvas.getByRole("list", { name: "Conversation transcript" })).toHaveTextContent("comparison is ready");
} };

export const CreditsRequired: Story = { render: () => <Fixture creditsRequired />, play: async ({canvasElement}) => { const c=within(canvasElement); await userEvent.click(c.getByRole("button", {name: "Start voice"})); await waitFor(() => expect(c.getByRole("alert")).toHaveTextContent("Add credits in Speko")); await expect(c.queryByRole("button", {name: "Mute"})).not.toBeInTheDocument(); } };
