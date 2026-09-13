import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { addons } from "storybook/preview-api";
import { expect, userEvent, within, waitFor } from "storybook/test";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Routes, Route, useNavigate } from "@/lib/router";
import { ChatEndpointSetup } from "@/pages/apps/chat/ChatEndpointSetup";
import { ChatEndpointDetail } from "@/pages/apps/chat/ChatEndpointDetail";
import { ConnectorCard } from "@/pages/apps/Browse";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import { Button } from "@/components/ui/button";
import type { ChatEndpoint, ChatIdentityLink } from "@/api/chatEndpoints";
import type { TaskChatMessageItem } from "@/components/task-chat/task-chat-model";
import { storybookAgents } from "../fixtures/paperclipData";

type Screen = "catalog" | "agent" | "credentials" | "access" | "task" | "reconnect";
type Scenario = { screen?: Screen; dedicated?: boolean; outage?: boolean; noLine?: boolean; loading?: boolean; connecting?: boolean };
const endpointId = "photon-story-endpoint";
const agent = storybookAgents[0];
const setupUrl = `/apps/chat/new?provider=imessage-photon&purpose=chat&agentId=${agent.id}`;
const sender: ChatIdentityLink = { id: "demo-link", principalId: "demo-person", externalLabel: "+15555550101", status: "pending" };
let endpoint: ChatEndpoint;
let principal: ChatIdentityLink | null;
let received = false;
let messages: TaskChatMessageItem[] = [];

function resetFixture(scenario: Scenario) {
  const established = ["access", "task", "reconnect"].includes(scenario.screen ?? "catalog");
  endpoint = {
    id: endpointId, companyId: agent.companyId, provider: "imessage-photon",
    status: established ? "verifying" : "draft", assignedAgentId: agent.id,
    assignedAgentName: agent.name, allowDirectMessages: true, allowUnlinkedPeople: false,
    allowGroupChats: false, photonAllocation: scenario.dedicated ? "dedicated" : "shared",
    setup: { step: established ? "test" : "provider_setup" },
    ...(established ? { providerAccountId: "demo-project", providerAccountLabel: "Demo project", botExternalId: "photon-project:demo-project" } : {}),
  };
  principal = established ? { ...sender } : null;
  received = false;
  messages = [];
  if (scenario.screen === "task") {
    principal = { ...sender, status: "linked", paperclipUserLabel: "Alex" };
    simulateIncoming();
  }
  if (scenario.screen === "reconnect") endpoint.status = "attention";
}

function simulateIncoming() {
  principal ??= { ...sender };
  if (principal.status !== "linked") return;
  received = true;
  const followUp = messages.length > 0;
  messages.push(
    { id: `input-${messages.length}`, kind: "message", author: "human", text: followUp ? "And what about the next step?" : "Help me plan the launch.", sourceChannel: "imessage-photon", timestamp: "2:00 PM" },
    { id: `reply-${messages.length}`, kind: "message", author: "agent", authorName: agent.name, text: followUp ? "Continuing our plan in DEMO-1. Next, review the launch checklist." : "Let’s start with the launch checklist. This conversation is DEMO-1.", timestamp: "2:00 PM" },
  );
}

function Journey({ screen = "catalog" }: { screen?: Screen }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [, rerender] = useState(0);
  useEffect(() => {
    navigate(screen === "catalog" ? "/apps" : screen === "task" ? "/issues/DEMO-1" : screen === "access" ? `/apps/chat/${endpointId}/access` : `${setupUrl}${screen === "agent" ? "" : `&resume=${endpointId}`}${screen === "reconnect" ? "&reconnect=1" : ""}`, { replace: true });
  }, [screen]);
  const refresh = () => { void queryClient.invalidateQueries(); rerender((n) => n + 1); };
  return <div className="mx-auto max-w-4xl space-y-6 p-4">
    <aside className="space-y-2 rounded-lg border border-border bg-muted p-3 text-sm">
      <p><strong>Simulated Photon demo.</strong> Production catalog, setup, access, management, and message components use local fixtures. No credentials are saved and no real messages are sent.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => { simulateIncoming(); refresh(); }}>Simulate incoming iMessage</Button>
        <Button size="sm" variant="outline" onClick={() => { principal = { ...sender, status: "linked", paperclipUserLabel: "Alex" }; refresh(); }}>Simulate identity confirmation</Button>
        <Button size="sm" variant="outline" onClick={() => navigate(`${setupUrl}&resume=${endpointId}`)}>Return to setup</Button>
        <Button size="sm" variant="outline" onClick={() => navigate("/issues/DEMO-1")}>View simulated task</Button>
      </div>
    </aside>
    <Routes>
      <Route path="/:companyPrefix/apps" element={<div role="list" aria-label="Connectors"><ConnectorCard
        row={{ key: "imessage-photon", slug: "imessage-photon", name: "iMessage Photon", description: "Message an agent from Apple Messages. Send photos and keep one task conversation.", brandKey: "imessage-photon", entry: null, applications: [], connections: [], chatEndpoints: [] }}
        allConnections={[]} userProfileById={new Map()} chatConnectorsEnabled
        onNavigate={() => navigate(setupUrl)} onRequestRemove={() => {}}
      /></div>} />
      <Route path="/:companyPrefix/apps/chat/new" element={<ChatEndpointSetup />} />
      <Route path="/:companyPrefix/apps/chat/:endpointId/:tab" element={<ChatEndpointDetail />} />
      <Route path="/:companyPrefix/issues/DEMO-1" element={<section className="space-y-4" aria-label="Simulated task conversation">
        <h1 className="text-xl font-bold">DEMO-1 · Launch plan</h1>
        <p className="text-sm text-muted-foreground">Each simulated reply completes a turn. Follow-ups stay on DEMO-1. Use /new or /close in Messages when you want a new task.</p>
        {messages.length ? messages.map((message) => <TaskChatBubble key={message.id} item={message} />) : <p>Link the sender, then simulate a fresh message to start work.</p>}
      </section>} />
    </Routes>
  </div>;
}

function Host(props: { screen?: Screen }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }));
  return <QueryClientProvider client={client}><Journey {...props} /></QueryClientProvider>;
}

const meta = {
  title: "Connections/iMessage Photon", component: Host,
  parameters: { layout: "fullscreen" },
  beforeEach: ({ parameters }) => {
    const scenario = (parameters.photonScenario ?? {}) as Scenario;
    resetFixture(scenario);
    delete document.body.dataset.photonStoryReady;
    delete document.body.dataset.photonStoryError;
    const channel = addons.getChannel();
    const report = (error: unknown) => { document.body.dataset.photonStoryError = JSON.stringify(error); };
    channel.on("playFunctionThrewException", report);
    channel.on("unhandledErrorsWhilePlaying", report);
    const original = window.fetch;
    let inspections = 0;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (url.pathname.endsWith("/agents")) return Response.json([agent]);
      if (url.pathname === "/api/instance/settings/experimental") return Response.json({ enableChatConnectors: true, enableIsolatedWorkspaces: false });
      if (url.pathname.includes("/chat-endpoints")) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url.pathname.endsWith("/photon/inspect")) {
          if (scenario.loading) return new Promise<Response>(() => {});
          if (scenario.outage && inspections++ === 0) return Response.json({ error: "Photon is temporarily unavailable. Try again.", details: { code: "photon_network" } }, { status: 503 });
          return Response.json({ projectId: "demo-project", projectName: "Demo project", allocation: scenario.dedicated ? "dedicated" : "shared", eligible: !scenario.noLine, lines: scenario.dedicated && !scenario.noLine ? [
            { lineId: "line-a", phoneNumber: "+15555550111", eligible: true },
            { lineId: "line-b", phoneNumber: "+15555550112", eligible: true },
          ] : [] });
        }
        if (url.pathname.endsWith("/setup")) {
          if (scenario.connecting) return new Promise<Response>(() => {});
          const number = body.photon?.lineId === "line-b" ? "+15555550112" : "+15555550111";
          endpoint = { ...endpoint, status: "verifying", setup: { step: "test" }, providerAccountId: "demo-project", providerAccountLabel: "Demo project", botExternalId: scenario.dedicated ? number : "photon-project:demo-project", botUsername: scenario.dedicated ? number : null };
        }
        if (url.pathname.endsWith("/test")) {
          if (!received) return Response.json({ error: "A linked sender must send a fresh test message and receive an agent reply." }, { status: 422 });
          endpoint = { ...endpoint, status: "active", setup: { step: "complete" } };
        }
        if (url.pathname.endsWith("/principals")) return Response.json(principal ? [principal] : []);
        if (url.pathname.endsWith("/resources") || url.pathname.endsWith("/activity")) return Response.json([]);
        if (url.pathname.endsWith("/conversations")) return Response.json(received ? [{ id: "demo-conversation", externalLabel: sender.externalLabel, issueId: "DEMO-1", issueIdentifier: "DEMO-1", issueTitle: "Launch plan", state: "active" }] : []);
        if (url.pathname.endsWith("/link-intent")) return Response.json({ confirmationUrl: `${window.location.origin}/simulated-photon-confirmation` });
        if (init?.method === "PATCH") endpoint = { ...endpoint, ...body };
        return Response.json(endpoint);
      }
      return original(input, init);
    };
    return () => { window.fetch = original; channel.off("playFunctionThrewException", report); channel.off("unhandledErrorsWhilePlaying", report); };
  },
  afterEach: ({ id }) => { document.body.dataset.photonStoryReady = id; },
} satisfies Meta<typeof Host>;
export default meta;
type Story = StoryObj<typeof meta>;
const step = (screen: Screen, scenario: Scenario = {}): Story => ({ args: { screen }, parameters: { photonScenario: { ...scenario, screen } } });
const inspect: Story["play"] = async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await userEvent.type(await canvas.findByLabelText("Project ID"), "demo-project");
  await userEvent.type(canvas.getByLabelText("Project secret"), "simulated-secret");
  await userEvent.click(canvas.getByRole("button", { name: "Inspect Photon project" }));
};
export const Catalog: Story = step("catalog");
export const ChooseAgent: Story = step("agent");
export const Credentials: Story = step("credentials");
export const Inspecting: Story = { ...step("credentials", { loading: true }), play: inspect };
export const Connecting: Story = { ...step("credentials", { connecting: true }), play: async (context) => {
  await inspect!(context); await userEvent.click(await within(context.canvasElement).findByRole("button", { name: "Connect shared DMs" }));
} };
export const MultipleDedicatedNumbers: Story = { ...step("credentials", { dedicated: true }), play: async (context) => {
  await inspect!(context); const canvas = within(context.canvasElement);
  await expect(await canvas.findByRole("button", { name: "Connect selected number" })).toBeDisabled();
  await userEvent.click(await canvas.findByRole("radio", { name: "+15555550112" }));
  await expect(canvas.getByRole("button", { name: "Connect selected number" })).toBeEnabled();
} };
export const NoEligibleLine: Story = { ...step("credentials", { dedicated: true, noLine: true }), play: async (context) => {
  await inspect!(context); await expect(await within(context.canvasElement).findByRole("alert")).toHaveTextContent("No eligible dedicated number");
} };
export const ProviderOutageRecovery: Story = { ...step("credentials", { outage: true }), play: async (context) => {
  await inspect!(context); const canvas = within(context.canvasElement);
  await expect(await canvas.findByRole("alert")).toHaveTextContent("temporarily unavailable");
  await userEvent.click(canvas.getByRole("button", { name: "Inspect Photon project" }));
  await expect(await canvas.findByRole("button", { name: "Connect shared DMs" })).toBeEnabled();
} };
export const Reconnect: Story = step("reconnect");
export const Access: Story = step("access");
export const IncomingFollowUps: Story = { ...step("task"), play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  await waitFor(() => expect(canvas.getByText("Sent from iMessage", { exact: false })).toBeVisible());
  await userEvent.click(canvas.getByRole("button", { name: "Simulate incoming iMessage" }));
  await expect(canvas.getByRole("heading", { name: "DEMO-1 · Launch plan" })).toBeVisible();
  await expect(canvas.getAllByText("Sent from iMessage", { exact: false })).toHaveLength(2);
} };
export const SharedDmWalkthrough: Story = { ...step("catalog"), play: async (context) => {
  const canvas = within(context.canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: "Connect iMessage Photon" }));
  await userEvent.click(await canvas.findByRole("button", { name: "Continue" }));
  await inspect!(context);
  await userEvent.click(await canvas.findByRole("button", { name: "Connect shared DMs" }));
  await expect(await canvas.findByRole("heading", { name: /Try .* in iMessage Photon/ })).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Simulate incoming iMessage" }));
  await userEvent.click(await canvas.findByRole("button", { name: "Review identity access" }));
  await expect(await canvas.findByRole("heading", { name: "External identity access" })).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "Simulate identity confirmation" }));
  await userEvent.click(canvas.getByRole("button", { name: "Return to setup" }));
  await userEvent.click(canvas.getByRole("button", { name: "Simulate incoming iMessage" }));
  await userEvent.click(await canvas.findByRole("button", { name: "I've sent the test message" }));
  await expect(await canvas.findByText(/Shared Photon project · direct messages only/)).toBeVisible();
  await userEvent.click(canvas.getByRole("button", { name: "View simulated task" }));
  await waitFor(() => expect(canvas.getByText("Sent from iMessage", { exact: false })).toBeVisible());
} };
export const NarrowMobile: Story = { ...IncomingFollowUps, globals: { viewport: { value: "mobile1", isRotated: false } } };
