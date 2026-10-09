import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useQueryClient } from "@tanstack/react-query";
import { Route, Routes, useNavigate } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { Layout } from "@/components/Layout";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { ChatEndpointDetail } from "@/pages/apps/chat/ChatEndpointDetail";
import { useCompany } from "@/context/CompanyContext";
import type { ChatEndpoint, ChatEndpointResource, ChatIdentityLink } from "@/api/chatEndpoints";
import { storybookAgents } from "../../fixtures/paperclipData";

type Scenario = "populated" | "empty" | "error" | "channel-added";
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
      setup: { step: "complete", slackApp: { appName: "Arlo", botName: "Arlo", command: "/arlo" } },
    };
    let resources: ChatEndpointResource[] = scenario === "empty" ? [] : [
      { id: "engineering", type: "channel", providerResourceId: "CENGINEERING", label: "#engineering", availability: "available", enabled: true },
      { id: "general", type: "channel", providerResourceId: "CGENERAL", label: "#general", availability: "available", enabled: false },
    ];
    let principals: ChatIdentityLink[] = scenario === "empty" ? [] : [
      { id: "ada", principalId: "ada", externalLabel: "@ada", paperclipUserLabel: "Ada Lovelace", paperclipUserId: "ada", status: "linked" },
      { id: "grace", principalId: "grace", externalLabel: "Grace Hopper", status: "pending" },
    ];
    let resourceReads = 0;
    window.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin);
      const path = url.pathname;
      const json = (data: unknown) => Response.json(data);
      if (path === `/api/agents/${agent.id}`) return json(agent);
      if (path === "/api/companies/company-storybook/agents") return json([agent, ...storybookAgents.slice(1)]);
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
      if (route === "principals") return json(principals);
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
  title: "Connections/Chat management",
  component: ChatManagementPage,
  parameters: { layout: "fullscreen", a11y: { test: "off" } },
  args: { tab: "settings", scenario: "populated" },
  argTypes: { tab: { control: "select", options: ["settings", "access", "conversations"] }, scenario: { control: "select", options: ["populated", "empty", "error", "channel-added"] } },
} satisfies Meta<typeof ChatManagementPage>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Settings: Story = { name: "1 · Settings" };
export const Access: Story = { name: "2 · People and access", args: { tab: "access" } };
export const InvitePeople: Story = {
  name: "3 · Invite people", args: { tab: "access" },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByRole("button", { name: "Invite people" }));
    await expect(within(document.body).getByRole("dialog")).toBeVisible();
  },
};
export const Conversations: Story = { name: "4 · Conversations", args: { tab: "conversations" } };
export const SlackAvatar: Story = {
  name: "5 · Slack avatar", args: { tab: "settings" },
  play: async ({ canvasElement }) => {
    await userEvent.click(await within(canvasElement).findByText("Agent avatar", { selector: "summary" }));
    await expect(within(canvasElement).getByRole("img", { name: "Arlo’s Cliptoon avatar" })).toBeVisible();
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
