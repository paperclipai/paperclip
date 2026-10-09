import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { Routes, Route, useNavigate, useLocation } from "react-router-dom";
import { CONNECTABLE_APP_DEFINITIONS } from "@paperclipai/shared";
import { Browse } from "@/pages/apps/Browse";
import { ChatEndpointSetup } from "@/pages/apps/chat/ChatEndpointSetup";
import { ChatEndpointDetail } from "@/pages/apps/chat/ChatEndpointDetail";
import { ChatIdentityConfirm } from "@/pages/apps/chat/ChatIdentityConfirm";
import type { ChatEndpoint } from "@/api/chatEndpoints";
import { queryKeys } from "@/lib/queryKeys";
import { spekoAgent, spekoCompanyId, spekoEndpoint } from "../fixtures/spekoNative";
import { callHistoryFixture } from "../fixtures/spekoCallHistory";
import { voiceStoryLifecycle } from "../fixtures/voiceStoryLifecycle";

type State = { status?: ChatEndpoint["status"]; step?: "provider_setup" | "test" | "complete"; failure?: boolean; conversations?: boolean; incoming?: "awaiting_approval" | "guest_intake"; history?: boolean; activity?: boolean; historyFailure?: boolean; unapprovedHistory?: boolean; agentName?: string };
const token = "storybook-identity-token-not-a-credential";
function PageFixture({ path, agents = [spekoAgent] }: { path: string; agents?: (typeof spekoAgent)[] }) {
  const navigate = useNavigate(), location = useLocation();
  const [opened, setOpened] = useState(false);
  const [client] = useState(() => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } } });
    client.setQueryData(queryKeys.instance.experimentalSettings, { enableChatConnectors: true });
    client.setQueryData(["chat-endpoint-setup-agents", spekoCompanyId], agents);
    client.setQueryData(queryKeys.apps.gallery(spekoCompanyId), { apps: CONNECTABLE_APP_DEFINITIONS.filter((app) => app.slug === "speko") });
    client.setQueryData(queryKeys.tools.applications(spekoCompanyId), []);
    client.setQueryData(queryKeys.tools.connections(spekoCompanyId), []);
    return client;
  });
  useEffect(() => { navigate(path, { replace: true }); setOpened(true); }, [navigate, path]);
  if (!opened) return <p>Opening fixture…</p>;
  return <QueryClientProvider client={client}><div className="p-4" data-fixture-location={location.pathname + location.search}>
    <Routes>
      <Route path="/PAP/apps" element={<Browse />} />
      <Route path="/PAP/apps/chat/connect" element={<ChatEndpointSetup />} />
      <Route path="/PAP/apps/chat/:endpointId/:tab" element={<ChatEndpointDetail />} />
      <Route path="/identity" element={<ChatIdentityConfirm />} />
    </Routes>
  </div></QueryClientProvider>;
}
const meta: Meta = {
  ...voiceStoryLifecycle, title: "Connections/Speko/Pages", parameters: { layout: "fullscreen" },
  beforeEach(context) {
    const cleanup = voiceStoryLifecycle.beforeEach(), original = window.fetch;
    const state = (context.parameters.speko ?? {}) as State;
    const endpoint = { ...spekoEndpoint, assignedAgentName: state.agentName ?? spekoEndpoint.assignedAgentName, status: state.status ?? "active", setup: { ...spekoEndpoint.setup, step: state.step ?? "complete" } };
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (url.pathname === "/api/health") return Response.json({ status: "ok", deploymentMode: "local_trusted", authReady: true, bootstrapStatus: "ready" });
      if (/\/voice-phone\/[^/]+\/incoming$/.test(url.pathname)) return Response.json(state.incoming ? [{id: "incoming-fixture", state: state.incoming, approvalCode: "482159", createdAt: "2026-10-07T17:00:00Z", expiresAt: "2026-10-07T17:10:00Z", sessionId: null, intakeIssueId: state.incoming === "guest_intake" ? "intake-fixture" : null}] : []);
      if (/\/voice-phone\/[^/]+\/history$/.test(url.pathname)) return Response.json(state.unapprovedHistory ? [{id: "missed-call", state: "denied", createdAt: "2026-10-07T17:04:00Z", updatedAt: "2026-10-07T17:04:01Z"}] : []);
      if (url.pathname.includes("/voice-phone/")) return Response.json({number: null, inventory: []});
      if (url.pathname.includes("/voice-history/")) return state.historyFailure ? Response.json({error: "Your access to this connection has changed."}, {status: 403}) : Response.json(state.history ? [callHistoryFixture] : []);
      if (url.pathname.endsWith("/issues")) return Response.json([]);
      if (url.pathname.includes("/voice-callbacks/")) return Response.json(null);
      if (url.pathname.startsWith("/api/voice-") || url.hostname.includes("speko.")) throw new Error("Stories must not start real calls");
      if (url.pathname.includes("/chat-endpoints")) {
        if (state.failure) return Response.json({ error: "Synthetic provider verification failed. Reconnect and try again." }, { status: 503 });
        if (url.pathname.endsWith("/conversations")) return Response.json(state.conversations ? [{ id: "conversation-fixture", externalLabel: "Browser voice", issueId: "task-fixture", issueIdentifier: "PAP-42", issueTitle: "Compare delivery options", state: "active", updatedAt: "2026-06-24T11:55:00Z", lastPublicationStatus: "published" }] : []);
        if (url.pathname.endsWith("/activity")) return Response.json({items: state.activity ? [
          {id: "newer-event", kind: "action", status: "completed", summary: "Speko connection verified", createdAt: "2026-10-07T17:03:00Z"},
          {id: "older-event", kind: "action", status: "completed", summary: "Speko credentials saved", createdAt: "2026-10-07T16:59:00Z"},
        ] : [], nextCursor: null});
        if (/\/(resources|principals)$/.test(url.pathname)) return Response.json([]);
        if (url.pathname.endsWith("/chat-endpoints")) return Response.json(init?.method === "POST" ? endpoint : [endpoint]);
        return Response.json(endpoint);
      }
      if (url.pathname === "/api/chat-identity-links/preview") return Response.json({ companyId: spekoCompanyId, companyName: "Example company", companyPrefix: "PAP", endpointId: endpoint.id, provider: "speko", externalLabel: "Voice session identity", botLabel: endpoint.botLabel, expiresAt: "2026-09-12T13:00:00Z" });
      return original(input, init);
    };
    return () => { window.fetch = original; cleanup(); };
  },
};
export default meta;
type Story = StoryObj;
function page(path: string, expected: string, state: State = {}): Story {
  return { parameters: { speko: state }, render: () => <PageFixture path={path} />, play: async ({ canvasElement }) => {
    await waitFor(() => expect(within(canvasElement).getAllByText(expected, { exact: false })[0]).toBeVisible());
    await Promise.all([...canvasElement.querySelectorAll("img")].map((image) => image.decode()));
  } };
}
const detail = (tab: string) => `/PAP/apps/chat/${spekoEndpoint.id}/${tab}`;
export const Catalog = page("/PAP/apps", "Speko");
export const ChooseAgent: Story = {
  ...page("/PAP/apps/chat/connect?provider=speko&purpose=chat", "Which agent do you want to chat with?"),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picker = await canvas.findByRole("button", { name: "Choose an active agent" });
    await expect(canvas.queryByRole("button", { name: "Review recommended agent" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Continue" })).toBeDisabled();
    picker.focus();
    await userEvent.keyboard("{Enter}");
    const agent = await within(document.body).findByRole("button", { name: `Select ${spekoAgent.name}` });
    agent.focus();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByRole("button", { name: "Continue" })).toBeEnabled();
  },
};
export const ChooseAgentLongName: Story = {
  ...ChooseAgent,
  render: () => <PageFixture path="/PAP/apps/chat/connect?provider=speko&purpose=chat" agents={[{ ...spekoAgent, name: "Head of International Customer Support and Technical Escalations" }]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Choose an active agent" }));
    await userEvent.click(await within(document.body).findByRole("button", { name: "Select Head of International Customer Support and Technical Escalations" }));
    await expect(canvas.getByRole("button", { name: "Continue" })).toBeEnabled();
  },
};
export const ChooseAgentEmpty: Story = {
  render: () => <PageFixture path="/PAP/apps/chat/connect?provider=speko&purpose=chat" agents={[]} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Choose an active agent" }));
    await expect(await within(document.body).findByText("No active agents are available.")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.getByRole("button", { name: "Choose an active agent" })).toHaveFocus();
    await expect(canvas.getByRole("button", { name: "Continue" })).toBeDisabled();
  },
};
export const ConfigureProvider = page(`/PAP/apps/chat/connect?provider=speko&resume=${spekoEndpoint.id}`, "Speko API key", { status: "draft", step: "provider_setup" });
export const TestConversation = page(`/PAP/apps/chat/connect?provider=speko&resume=${spekoEndpoint.id}`, "Test your Speko voice connection", { status: "verifying", step: "test" });
export const Active = page(detail("settings"), "Company Phone Agent in Speko");
export const Paused = page(detail("settings"), "Company Phone Agent in Speko", { status: "paused" });
export const Attention = page(detail("settings"), "Company Phone Agent in Speko", { status: "attention" });
export const Revoked = page(detail("settings"), "Company Phone Agent in Speko", { status: "revoked" });
export const Removed = page(detail("settings"), "Company Phone Agent in Speko", { status: "archived" });
export const LoadingFailure = page(detail("settings"), "This chat connection could not be loaded", { failure: true });
export const PrivateAccess = page(detail("access"), "Private voice access");
export const Conversations = page(detail("conversations"), "Compare delivery options", { conversations: true });
export const ConversationsEmpty = page(detail("conversations"), "No conversations yet");
export const ActivityEmpty = page(detail("activity"), "Connection activity");
export const IdentityProviderLabel = page(`/identity?token=${token}`, "Voice session identity");

export const SetupKeepsResumeLink: Story = {
  parameters: { speko: { status: "draft", step: "provider_setup" } },
  render: () => <PageFixture path={`/PAP/apps/chat/connect?provider=speko&purpose=chat&agentId=${spekoAgent.id}`} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /^Continue$/ }));
    await waitFor(() => expect(canvasElement.querySelector("[data-fixture-location]")?.getAttribute("data-fixture-location")).toContain(`resume=${spekoEndpoint.id}`));
    await expect(await canvas.findByLabelText("Speko API key", { exact: true })).toHaveAttribute("type", "password");
  },
};

export const PendingIncoming = page(detail("settings"), "Incoming call awaiting approval", {incoming: "awaiting_approval"});
export const GuestIntake = page(detail("settings"), "Incoming conversation", {incoming: "guest_intake"});
export const WithCallHistory = page(detail("activity"), "Outgoing call · Completed", {history: true});
export const SettingsWithoutCallHistory: Story = {
  ...page(detail("settings"), "Company Phone Agent in Speko", {history: true}),
  play: async ({canvasElement}) => {
    const c = within(canvasElement);
    await expect(await c.findByText("Company Phone Agent in Speko")).toBeVisible();
    await expect(c.queryByRole("heading", {name: "Your calls"})).not.toBeInTheDocument();
    await expect(c.queryByRole("button", {name: "Start voice"})).not.toBeInTheDocument();
    await expect(c.queryByRole("combobox", {name: "Conversation"})).not.toBeInTheDocument();
    await expect(c.queryByText(/Let this agent call your saved number/)).not.toBeInTheDocument();
    await expect(c.getByRole("link", {name: "Open Speko"})).toHaveAttribute("href", "https://platform.speko.ai/agents");
    await waitFor(() => expect(canvasElement.querySelector('header img[src="/brands/apps/speko.svg"]')).toBeInTheDocument());
    await expect(c.queryByText("Outgoing call · Completed", {exact: false})).not.toBeInTheDocument();
  },
};
export const ActivityWithMixedEntries: Story = {
  ...page(detail("activity"), "Outgoing call · Completed", {history: true, activity: true}),
  play: async ({canvasElement}) => {
    const c = within(canvasElement);
    await expect(await c.findByText("Speko credentials saved")).toBeVisible();
    await waitFor(() => expect([...canvasElement.querySelectorAll("[data-activity-kind]")].map(row => row.getAttribute("data-activity-kind"))).toEqual(["connection", "call", "connection"]));
    await userEvent.click(await c.findByText("Outgoing call · Completed", {exact: false}));
    await expect(c.getByRole("list", {name: "Call transcript"})).toBeVisible();
    await expect(c.getByRole("link", {name: "Conversation task"})).toHaveAttribute("href", expect.stringContaining("/issues/task"));
    await expect(c.getByText("$0.152340 USD")).toBeVisible();
  },
};
export const ActivityUnapprovedCall = page(detail("activity"), "Call denied", {unapprovedHistory: true});
export const ActivityCallHistoryFailure = page(detail("activity"), "Call activity could not be loaded", {historyFailure: true, activity: true});
export const PausedCallHistory = page(detail("activity"), "Outgoing call · Completed", {history: true, status: "paused"});

export const LongAgentHeader = page(detail("settings"), "Head of International Customer Support and Technical Escalations", {agentName: "Head of International Customer Support and Technical Escalations"});
