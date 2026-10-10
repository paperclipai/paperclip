import { StrictMode, useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { VoiceSession } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { VoiceCallProvider } from "@/components/voice/VoiceCallProvider";
import { NativeVoiceConversation } from "@/components/voice/NativeVoiceConversation";
import type { voiceSessionsApi } from "@/api/voiceSessions";
import type { connectSpekoVoiceMedia } from "@/lib/speko-voice-media";
import { voiceStoryLifecycle } from "../fixtures/voiceStoryLifecycle";

function Fixture({ longConversation = false }: { longConversation?: boolean }) {
  const [companyId, setCompany] = useState("company-storybook");
  const [userId, setUser] = useState<string | null>("operator");
  const [page, setPage] = useState("agent");
  const [started, setStarted] = useState(0), [closed, setClosed] = useState(0);
  const [intent, setIntent] = useState("none");
  const fixture = useMemo(() => {
    const session: VoiceSession = { id: "fixture-call", companyId: "company-storybook", endpointId: "fixture-endpoint", issueId: "fixture-task", assignedAgentId: "agent-codex", state: "active", mode: "browser", generation: 1, callerAuthority: "member", replyCursor: 0, createdAt: "2026-10-07T12:00:00Z", expiresAt: "2026-10-07T12:10:00Z", endedAt: null, errorCode: null };
    const client: typeof voiceSessionsApi = {
      async start(_company, input) { setStarted(n => n + 1); setIntent(input.newConversation ? "new" : "continue"); return { session, media: { sessionId: session.id, generation: 1, transportToken: "fixture-only", transportUrl: "wss://fixture.invalid" } }; },
      async get() { return session; }, async end() { return { ...session, state: "ended" }; }, async notification() { return null; },
    };
    const connect: typeof connectSpekoVoiceMedia = async (_credentials, callbacks) => {
      callbacks.onModeChange("listening");
      if (longConversation) for (let i = 0; i < 30; i++) callbacks.onMessage({ source: i % 2 ? "agent" : "user", segmentId: `segment-${i}`, text: `Turn ${i + 1}. Please include the additional context for the project, and keep the same task open while we discuss the result.`, isFinal: true });
      return { async endSession() { setClosed(n => n + 1); }, async setMicMuted() {}, async startAudioPlayback() {}, async sendChatMessage() {} };
    };
    return { client, connect };
  }, [longConversation]);
  return <StrictMode><VoiceCallProvider companyId={companyId} userId={userId}>
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2"><Button onClick={() => setPage(p => p === "agent" ? "tasks" : "agent")}>Navigate</Button><Button onClick={() => setCompany("another-company")}>Switch company</Button><Button onClick={() => setUser(null)}>Sign out</Button></div>
      <p data-testid="page">{page === "agent" ? "Agent page" : "Tasks page"}</p>
      <p data-testid="calls">Started: {started}; media closed: {closed}; intent: {intent}</p>
      {page === "agent" && <NativeVoiceConversation companyId={companyId} endpointId="fixture-endpoint" agentName="Company Phone Agent" {...fixture} />}
    </div>
  </VoiceCallProvider></StrictMode>;
}
const meta: Meta<typeof VoiceCallProvider> = { ...voiceStoryLifecycle, title: "Connections/Speko/Call provider", component: VoiceCallProvider, render: () => <Fixture />, parameters: { layout: "padded" } };
export default meta;
type Story = StoryObj<typeof meta>;
const start: NonNullable<Story["play"]> = async ({ canvasElement }) => {
  const c = within(canvasElement);
  await userEvent.click(c.getByRole("button", { name: "Start voice" }));
  await waitFor(() => expect(c.getByRole("button", { name: "Mute" })).toBeEnabled());
  await expect(c.getByTestId("calls")).toHaveTextContent("Started: 1; media closed: 0");
};
export const Initial: Story = {};
export const Active: Story = { play: start };
export const Navigation: Story = { play: async context => {
  await start(context); const c = within(context.canvasElement);
  await userEvent.click(c.getByRole("button", { name: "Navigate" }));
  await expect(c.getByTestId("page")).toHaveTextContent("Tasks page");
  await expect(c.getByRole("button", { name: "Mute" })).toBeEnabled();
  await expect(c.getByTestId("calls")).toHaveTextContent("Started: 1; media closed: 0");
} };
export const NewConversation: Story = { play: async context => {
  const c = within(context.canvasElement);
  await userEvent.selectOptions(c.getByRole("combobox", { name: "Conversation" }), "new");
  await start(context); await expect(c.getByTestId("calls")).toHaveTextContent("intent: new");
} };
export const CompanyChange: Story = { play: async context => {
  await start(context); const c = within(context.canvasElement);
  await userEvent.click(c.getByRole("button", { name: "Switch company" }));
  await waitFor(() => expect(c.getByTestId("calls")).toHaveTextContent("media closed: 1"));
  await expect(c.queryByRole("complementary", { name: "Current voice call" })).not.toBeInTheDocument();
} };
export const SignOut: Story = { play: async context => {
  await start(context); const c = within(context.canvasElement);
  await userEvent.click(c.getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(c.getByTestId("calls")).toHaveTextContent("media closed: 1"));
} };
export const EndAndRestart: Story = { play: async context => {
  await start(context); const c = within(context.canvasElement);
  await userEvent.click(c.getByRole("button", { name: "End call" }));
  await waitFor(() => expect(c.getByTestId("calls")).toHaveTextContent("media closed: 1"));
  await expect(c.getByRole("button", { name: "Voice panel open" })).toBeDisabled();
  await userEvent.click(c.getByRole("button", { name: "Close voice panel" }));
  await waitFor(() => expect(c.getByRole("button", { name: "Start voice" })).toHaveFocus());
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(c.getByTestId("calls")).toHaveTextContent("Started: 2; media closed: 1"));
  await expect(c.getByRole("button", { name: "Mute" })).toBeEnabled();
} };

export const LongConversation: Story = { render: () => <Fixture longConversation />, play: async context => {
  await start(context); const c = within(context.canvasElement);
  const panel = c.getByRole("complementary", { name: "Current voice call" });
  const bounds = panel.getBoundingClientRect();
  await expect(bounds.top).toBeGreaterThanOrEqual(0);
  await expect(bounds.bottom).toBeLessThanOrEqual(window.innerHeight);
  const transcript = c.getByRole("region", { name: "Voice transcript history" });
  transcript.focus(); await expect(transcript).toHaveFocus();
  await expect(c.getByRole("button", { name: "End call" })).toBeVisible();
} };

export const RestartInPanel: Story = { play: async context => {
  await start(context); const c = within(context.canvasElement);
  await userEvent.click(c.getByRole("button", { name: "End call" }));
  await waitFor(() => expect(c.getByRole("button", { name: "Close voice panel" })).toBeVisible());
  await userEvent.click(c.getByRole("button", { name: "Start voice" }));
  await waitFor(() => expect(c.getByTestId("calls")).toHaveTextContent("Started: 2; media closed: 1"));
  await expect(c.getByRole("button", { name: "Mute" })).toBeEnabled();
  await expect(c.queryByRole("button", { name: "Close voice panel" })).not.toBeInTheDocument();
} };
