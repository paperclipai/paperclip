import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { Route, Routes, useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { Layout } from "@/components/Layout";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { ChatEndpointDetail } from "@/pages/apps/chat/ChatEndpointDetail";
import { useCompany } from "@/context/CompanyContext";
import type { ChatEndpoint, ChatEndpointResource, ChatIdentityLink } from "@/api/chatEndpoints";
import userAvatar from "../../../prototypes/slack-avatar/ceo-cliptoon.png";
import { storybookAgents, storybookExecutionWorkspaces } from "../../../fixtures/paperclipData";

type Scenario = "populated" | "empty" | "error" | "channel-added" | "unlinked" | "invitation-expired";
function ChatManagementPage({ tab = "settings", scenario = "populated" }: { tab?: string; scenario?: Scenario }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { setSelectedCompanyId } = useCompany();
  const initialTab = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previous = window.fetch;
    const agent = { ...storybookAgents[0], name: "Arlo" };
    let endpoint: ChatEndpoint = {
      id: "chat-management", companyId: "company-storybook", provider: "slack", status: "active",
      assignedAgentId: agent.id, assignedAgentName: agent.name, providerAccountId: "TSTORY",
      providerAccountLabel: "Paperclip", botExternalId: "UARLO", botLabel: "Arlo", botUsername: "arlo-paperclip",
      allowUnlinkedPeople: false, allowDirectMessages: true,
      setup: { step: "complete", slackRegistration: { status: "configured", appId: "ASTORY" }, slackApp: { appName: "Arlo", botName: "Arlo", command: "/arlo" } },
    };
    let resources: ChatEndpointResource[] = scenario === "empty" ? [] : [
      { id: "engineering", type: "channel", providerResourceId: "CENGINEERING", label: "#engineering", availability: "available", enabled: true },
      { id: "general", type: "channel", providerResourceId: "CGENERAL", label: "#general", availability: "available", enabled: false },
    ];
    let principals: ChatIdentityLink[] = scenario === "empty" ? [] : [
      { id: "ada", principalId: "ada", externalLabel: "@ada", paperclipUserLabel: "Ada Lovelace", paperclipUserId: "ada", paperclipUserImage: userAvatar, status: "linked" },
      { id: "alan", principalId: "alan", externalLabel: "@alan", paperclipUserLabel: "Alan Turing", paperclipUserImage: null, status: "linked" },
      { id: "grace", principalId: "grace", externalLabel: "Grace Hopper", status: "pending" },
    ];
    let resourceReads = 0;
    let invitationSent = false;
    let invitationConfirmed = false;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      const path = url.pathname;
      const json = (data: unknown) => Response.json(data);
      if (path === `/api/agents/${agent.id}`) return json(agent);
      if (path === "/api/companies/company-storybook/agents") return json([agent, ...storybookAgents.slice(1)]);
      if (path === "/api/companies/company-storybook/execution-workspaces" && url.searchParams.get("selectableForTask") === "true") {
        return json(storybookExecutionWorkspaces.filter(workspace =>
          workspace.closedAt == null && ["active", "idle"].includes(workspace.status)));
      }
      if (path === "/api/chat-endpoints/chat-management") {
        if (init?.method === "PATCH") endpoint = { ...endpoint, ...JSON.parse(String(init.body)) };
        return json(endpoint);
      }
      if (path.startsWith("/api/companies/company-storybook/slack/endpoints/chat-management/")) {
        return json(path.endsWith("capabilities") ? { missingScopes: [], tools: [] } : { configured: true, connected: false, canConfigure: false, nativeSearchAvailable: true });
      }
      const route = path.replace("/api/chat-endpoints/chat-management/", "");
      if (["resources", "principals", "conversations"].includes(route) && scenario === "error") return Response.json({ error: "Unable to load this connection. Try again." }, { status: 503 });
      if (route === "resources") {
        if (init?.method === "PUT") {
          const updates = JSON.parse(String(init.body)).resources;
          resources = resources.map(item => ({ ...item, ...updates.find((update: ChatEndpointResource) => update.id === item.id) }));
        }
        if (scenario === "channel-added" && (!init?.method || init.method === "GET") && ++resourceReads === 2) {
          resources = [...resources, { id: "design", type: "channel", providerResourceId: "CDESIGN", label: "#design", availability: "available", enabled: true }];
        }
        return json(resources);
      }
      if (route === "slack/test-message") {
        if ((scenario === "unlinked" || scenario === "invitation-expired") && !invitationConfirmed) {
          if (!JSON.parse(String(init?.body)).slackUserId) return json({ status: "connection_required", accounts: [{ id: "UADA", name: "Ada Lovelace" }], nextCursor: null });
          invitationSent = true;
          return json({ status: "connection_pending", principalId: "ada", expiresAt: new Date(Date.now() + (scenario === "invitation-expired" ? 50 : 600_000)).toISOString() });
        }
        return json({ status: "sent", slackUrl: "https://app.slack.com/client/TSTORY/DADA" });
      }
      if (route === "principals") {
        if (invitationSent && scenario !== "invitation-expired") invitationConfirmed = true;
        return json(scenario === "invitation-expired" ? [] : principals);
      }
      if (route.endsWith("/link-intent")) return json({ confirmationUrl: "https://example.test/chat-identity/confirm?token=storybook-only" });
      if (route.endsWith("/link") && init?.method === "DELETE") {
        principals = principals.map(person => route.includes(person.id) ? { ...person, status: "revoked", paperclipUserId: null } : person);
        return json({ ok: true });
      }
      if (route === "conversations") return json(scenario === "empty" ? [] : [
        { id: "conversation-1", externalLabel: "#engineering", externalUrl: "https://app.slack.com/client/TSTORY/CENGINEERING", issueId: "PAP-42", issueIdentifier: "PAP-42", issueTitle: "Review this week's deployment failures", state: "active", updatedAt: new Date().toISOString() },
        { id: "conversation-2", externalLabel: "Ada · DM", externalUrl: "https://app.slack.com/client/TSTORY/DADA", issueId: "PAP-39", issueIdentifier: "PAP-39", issueTitle: "Summarize the latest customer feedback", state: "completed", updatedAt: new Date().toISOString() },
      ]);
      return previous(input, init);
    };
    queryClient.removeQueries({ queryKey: ["chat-endpoints"] });
    setSelectedCompanyId("company-storybook");
    queryClient.setQueryData(queryKeys.chatEndpoints.detail(endpoint.id), endpoint);
    setReady(true);
    return () => { window.fetch = previous; };
  }, [scenario, queryClient, setSelectedCompanyId]);
  useEffect(() => {
    if (initialTab.current === tab) return;
    initialTab.current = tab;
    navigate(`/PAP/apps/chat/chat-management/${tab}`, { replace: true });
  }, [tab, navigate]);
  if (!ready) return null;
  return <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}>
    <Route path="apps/chat/:endpointId/:tab" element={<ChatEndpointDetail />} />
  </Route></Routes></PluginLauncherProvider>;
}

const meta = {
  id: "connections-chat-management",
  title: "Apps, channels, and extensions/External chat and email/Connections/Chat management",
  component: ChatManagementPage,
  parameters: { layout: "fullscreen", a11y: { test: "off" },
    paperclip: {
      "capabilities": [
        "chat-channels/lifecycle",
        "chat-channels/identity",
        "chat-channels/conversation"
      ],
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "Task-workspace reconciliation: the mounted endpoint adds connection and destination editors. Local endpoint PATCH/resource PUT preserve defaults; workspace-choice requests now return only active/idle, unclosed fixture workspaces. Browser save/error/reload and new-conversation inheritance remain unverified. Inspected channel task-default controls, optional API fields, avatar rendering and matching fixture updates; live defaults inheritance and permission checks remain outside these stories. Access, InvitePeople, ConnectAndTest and Conversations render the shipped endpoint detail with simulated identity linking and conversation data. External delivery and identity authorization are not live."
    },
  },
  args: { tab: "settings", scenario: "populated" },
  argTypes: { tab: { control: "select", options: ["settings", "access", "conversations"] }, scenario: { control: "select", options: ["populated", "empty", "error", "channel-added"] } },
} satisfies Meta<typeof ChatManagementPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Settings: Story = { name: "1 · Settings" };
export const Access: Story = {
  name: "2 · People and access", args: { tab: "access" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = await canvas.findByText("Ada Lovelace");
    await expect(name).toHaveAttribute("title", "Ada Lovelace");
    const row = name.closest('[role="listitem"]')!;
    const avatar = row.querySelector('[data-slot="avatar"]')!;
    await waitFor(() => expect(avatar.querySelector("img")).toBeVisible());
    await expect(canvas.getByText("AT")).toBeVisible();
    const center = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top + bounds.height / 2;
    };
    await expect(Math.abs(center(avatar) - center(name.parentElement!))).toBeLessThan(1);
    await expect(Math.abs(center(avatar) - center(within(row as HTMLElement).getByRole("button", { name: "Disconnect" })))).toBeLessThan(1);
  },
};
export const InvitePeople: Story = {
  name: "3 · Invite people", args: { tab: "access" },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Invite people" }));
    await expect(within(document.body).getByRole("dialog")).toBeVisible();
  },
};
export const Conversations: Story = { name: "4 · Conversations", args: { tab: "conversations" } };
export const TestMessage: Story = {
  name: "5 · Test message", args: { tab: "settings" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Send me a test message" }));
    await expect(await canvas.findByRole("button", { name: "Test message sent" })).toBeVisible();
    await expect(canvas.queryByRole("link", { name: "View message" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: "Open Slack configuration" })).toHaveAttribute("href", "https://api.slack.com/apps/ASTORY/oauth");
    await expect(canvas.queryByText("Agent avatar")).not.toBeInTheDocument();
    await expect(canvas.queryByText("Message in a channel")).not.toBeInTheDocument();
  },
};
export const ConnectAndTest: Story = {
  name: "Connect and send test message", args: { tab: "settings", scenario: "unlinked" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Send me a test message" }));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("radio", { name: "Ada Lovelace (UADA)" }));
    await userEvent.click(page.getByRole("button", { name: "Send connection invitation" }));
    await expect(await canvas.findByRole("button", { name: "Test message sent" })).toBeVisible();
  },
};
export const InvitationExpired: Story = {
  name: "Expired Slack invitation", args: { tab: "settings", scenario: "invitation-expired" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Send me a test message" }));
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole("radio", { name: "Ada Lovelace (UADA)" }));
    await userEvent.click(page.getByRole("button", { name: "Send connection invitation" }));
    await expect(await canvas.findByRole("button", { name: "Request a new invitation" })).toBeEnabled();
  },
};
export const ChannelAdded: Story = {
  name: "6 · Channel invited", args: { scenario: "channel-added" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("switch", { name: "Enable #design" }, { timeout: 10_000 })).toBeChecked();
    await expect(canvas.getByText("Invite Arlo to a channel to add it")).toBeVisible();
  },
};
export const SlackTools: Story = {
  name: "7 · Slack tools",
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByText("Slack tools", { selector: "summary" }));
    await expect(within(canvasElement).getByText("Read, search, and act in Slack. Some actions require approval.")).toBeVisible();
  },
};
export const NoPeople: Story = { args: { tab: "access", scenario: "empty" } };
export const NoChannels: Story = { args: { scenario: "empty" } };
export const NoConversations: Story = { args: { tab: "conversations", scenario: "empty" } };
export const LoadFailure: Story = { args: { tab: "access", scenario: "error" } };
export const MobileAccess: Story = { args: { tab: "access" }, globals: { viewport: { value: "mobile1", isRotated: false } } };
export const MobileConversations: Story = { args: { tab: "conversations" }, globals: { viewport: { value: "mobile1", isRotated: false } } };
