import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { VoiceCallContext } from "@/components/voice/VoiceCallContext";
import { Button } from "@/components/ui/button";
import { queryKeys } from "@/lib/queryKeys";
import { TaskVoiceLauncher } from "@/components/voice/TaskVoiceLauncher";
import { AgentChannelsPanel } from "@/components/chat/AgentChannelsPanel";
import { ExternallyConnectedTaskBanner } from "@/components/chat/ExternallyConnectedTaskBanner";
import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { chatEndpointsApi } from "@/api/chatEndpoints";
import { SpekoQueryFixture, spekoAgent, spekoCompanyId, spekoEndpoint } from "../../../support/speko/spekoNative";
import { voiceStoryLifecycle } from "../../../support/speko/voiceStoryLifecycle";
const props = { companyId: spekoCompanyId, issueId: "task-fixture", agentId: spekoAgent.id };
const meta: Meta<typeof TaskVoiceLauncher> = { ...voiceStoryLifecycle, id: "connections-speko-task-launcher", title: "Apps, channels, and extensions/External chat and email/Speko/Task launcher", component: TaskVoiceLauncher, parameters: { layout: "padded", paperclip: {"capabilities": ["chat-channels/conversation", "chat-channels/lifecycle"], "status": "current", "implementation": "production", "boundary": "fixtures", "notes": "Production task launcher and connection surfaces with fixture endpoints. Persona recovery uses a simulated call-host transition; it never opens media or creates a call."} } };
export default meta;
type Story = StoryObj<typeof meta>;
export const ExistingAgent: Story = { render: () => <SpekoQueryFixture><TaskVoiceLauncher {...props} /></SpekoQueryFixture> };
export const MultiplePersonas: Story = { render: () => <SpekoQueryFixture endpoints={[spekoEndpoint, { ...spekoEndpoint, id: "second", botLabel: "International customer reception and technical escalation" }]}><TaskVoiceLauncher {...props} /></SpekoQueryFixture> };
export const UnavailableAgent: Story = { render: () => <SpekoQueryFixture endpoints={[]}><TaskVoiceLauncher {...props} boundEndpointId={spekoEndpoint.id} /></SpekoQueryFixture> };
export const AgentChannels: Story = { render: () => <SpekoQueryFixture><AgentChannelsPanel companyId={spekoCompanyId} agentId={spekoAgent.id} /></SpekoQueryFixture> };
export const ConnectionLifecycle: Story = { render: () => <SpekoQueryFixture endpoints={["active", "paused", "attention", "verifying", "revoked"].map((status) => ({ ...spekoEndpoint, id: status, status: status as typeof spekoEndpoint.status, botLabel: `Company reception · ${status}` }))}><AgentChannelsPanel companyId={spekoCompanyId} agentId={spekoAgent.id} /></SpekoQueryFixture> };
function BoundTask() {
  const client = useQueryClient();
  useState(() => client.setQueryData(["issue-chat-binding", spekoCompanyId, props.issueId], { endpointId: spekoEndpoint.id, provider: "speko", externalLabel: "Voice conversation", conversationId: "conversation", assignedAgentLocked: true }));
  return <ExternallyConnectedTaskBanner companyId={spekoCompanyId} issueId={props.issueId} assigneeAgentId={spekoAgent.id} />;
}
export const BoundTaskBanner: Story = { render: () => <SpekoQueryFixture><BoundTask /></SpekoQueryFixture> };
export const KeyboardOpen: Story = {
  ...ExistingAgent,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    canvas.getByRole("button", { name: `Talk to ${spekoAgent.name}` }).focus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("button", { name: "Start voice" })).toBeVisible();
    await expect(canvas.getByText("Ready to talk")).toBeVisible();
    // Opening controls must not acquire a microphone or create a session.
  },
};

/** Seed a failed query; retries resolve locally and never contact a provider. */
function TaskConnectionFailure({ bound = false }: { bound?: boolean }) {
  const client = useQueryClient();
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const original = chatEndpointsApi.list;
    chatEndpointsApi.list = async () => [spekoEndpoint];
    const queryKey = queryKeys.chatEndpoints.list(spekoCompanyId);
    client.removeQueries({ queryKey });
    client.setQueryDefaults(queryKey, { retryOnMount: false });
    client.getQueryCache().build(client, { queryKey }).setState({ status: "error", error: new Error("Fixture connection failure"), fetchStatus: "idle" });
    setReady(true);
    return () => { chatEndpointsApi.list = original; client.removeQueries({ queryKey }); };
  }, [client]);
  return ready ? <TaskVoiceLauncher {...props} boundEndpointId={bound ? spekoEndpoint.id : undefined} /> : null;
}
export const ConnectionLoadFailure: Story = { render: () => <SpekoQueryFixture><TaskConnectionFailure /></SpekoQueryFixture> };
export const BoundConnectionRecovery: Story = {
  render: () => <SpekoQueryFixture><TaskConnectionFailure bound /></SpekoQueryFixture>,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Voice connections could not be loaded.");
    canvas.getByRole("button", { name: "Retry voice connections" }).focus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("button", { name: `Talk to ${spekoAgent.name}` })).toBeVisible();
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(canvas.getByRole("button", { name: `Talk to ${spekoAgent.name}` })).toHaveFocus());
  },
};

function PersonaRecovery() {
  const [active, setActive] = useState(false);
  return <VoiceCallContext.Provider value={{active, open: () => setActive(true)}}>
    <TaskVoiceLauncher {...props} />
    {active && <Button onClick={() => setActive(false)}>Close voice panel</Button>}
  </VoiceCallContext.Provider>;
}
export const PersonaAfterPanelClose: Story = {
  render: () => <SpekoQueryFixture endpoints={[spekoEndpoint, {...spekoEndpoint, id: "second", botLabel: "Second persona"}]}><PersonaRecovery /></SpekoQueryFixture>,
  play: async ({canvasElement}) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", {name: `Talk to ${spekoAgent.name}`}));
    await userEvent.click(canvas.getByRole("button", {name: "Start voice"}));
    await userEvent.click(canvas.getByRole("button", {name: "Close voice panel"}));
    await waitFor(() => expect(canvas.getByRole("button", {name: `Talk to ${spekoAgent.name}`})).toHaveFocus());
    await userEvent.selectOptions(canvas.getByRole("combobox", {name: "Voice persona"}), "second");
    await expect(canvas.getByRole("combobox", {name: "Voice persona"})).toHaveValue("second");
  },
};

function SharedConnectionState() {
  const client = useQueryClient();
  return <><TaskVoiceLauncher {...props} boundEndpointId={spekoEndpoint.id} />
    <Button onClick={() => client.setQueryData(queryKeys.chatEndpoints.list(spekoCompanyId), [{...spekoEndpoint, status: "paused"}])}>Pause fixture connection</Button>
    <Button onClick={() => client.setQueryData(queryKeys.chatEndpoints.list(spekoCompanyId), [spekoEndpoint])}>Resume fixture connection</Button>
  </>;
}
export const SharedPauseResume: Story = {
  render: () => <SpekoQueryFixture><SharedConnectionState /></SpekoQueryFixture>,
  play: async ({canvasElement}) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", {name: `Talk to ${spekoAgent.name}`})).toBeVisible();
    await userEvent.click(canvas.getByRole("button", {name: "Pause fixture connection"}));
    await expect(canvas.getByText("Voice is unavailable. Check the Speko connection in Apps.")).toBeVisible();
    await expect(canvas.queryByRole("button", {name: `Talk to ${spekoAgent.name}`})).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", {name: "Resume fixture connection"}));
    await expect(canvas.getByRole("button", {name: `Talk to ${spekoAgent.name}`})).toBeVisible();
  },
};
