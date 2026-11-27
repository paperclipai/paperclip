import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { AgentDetail, GrokConnection } from "@paperclipai/shared";
import { ConfigurationTab } from "@/pages/AgentDetail";
import { storybookAgents } from "../../../fixtures/paperclipData";

const agent: AgentDetail = {
  ...storybookAgents[0]!, id: "grok-config-agent", name: "Night Shift", urlKey: "night-shift",
  adapterType: "paperclip_runner", adapterConfig: { provider: "grok_bot", allowUnmeteredProvider: true },
  chainOfCommand: [], access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
};
const bindingId = "11111111-1111-4111-8111-111111111111";
const at = "2026-10-13T12:00:00Z";
const connection: GrokConnection = {
  enabled: true, resourceUrl: "https://paperclip.example/mcp/runner", agentStatus: "idle",
  agentLifecycleState: "ready", canConfigureConnection: true, recoveryNeeded: false,
  binding: {
    id: bindingId, providerKind: "grok_bot", status: "ready", connected: true, subscriptionVerified: false,
    hasPendingChallenge: false, pairingExpiresAt: null, challengeExpiresAt: null, wakeVerified: true,
    routine: { bindingId, botName: "Night Shift", revision: 1, configured: true, verified: true,
      verifiedAt: at, lastContactAt: at, recoveryNeeded: false, lastExchange: {
        id: "synthetic-exchange", kind: "verify", status: "acknowledged", httpStatus: 200,
        sentAt: at, acknowledgedAt: at, expiresAt: "2099-01-01T00:00:00Z",
      } },
  },
};
const ignore = () => {};

function Configuration({ disconnected = false }: { disconnected?: boolean }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const previous = window.fetch;
    const fixture: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
      if (url.pathname === `/api/companies/${agent.companyId}/agents/${agent.id}/grok-binding`) {
        if (disconnected && init?.method === "POST") return Response.json({ bindingId,
          pairingCode: "synthetic-reconnect-code", expiresAt: new Date(Date.now() + 900000).toISOString() });
        if ((init?.method ?? "GET") !== "GET") return Response.json({ error: "This preview does not authorize connections." }, { status: 405 });
        return Response.json(disconnected ? { ...connection, binding: null } : connection);
      }
      return previous(input, init);
    };
    window.fetch = fixture;
    setReady(true);
    return () => { if (window.fetch === fixture) window.fetch = previous; client.clear(); };
  }, [client, disconnected]);
  return <QueryClientProvider client={client}><main className="space-y-6 p-6">
    <h1 className="text-xl font-semibold">Night Shift · Runtime</h1>
    {ready && <ConfigurationTab agent={agent} companyId={agent.companyId} content="runtime"
      onDirtyChange={ignore} onSaveActionChange={ignore} onCancelActionChange={ignore} onSavingChange={ignore}
      updatePermissions={{ mutate: ignore, isPending: false }} />}
  </main></QueryClientProvider>;
}

const meta = {
  id: "grok-bot-configuration",
  title: "Agents and reusable capabilities/Hiring, configuration, and organization/Onboarding/Grok Bot/Configuration",
  component: Configuration,
  tags: ["autodocs"],
  parameters: { layout: "fullscreen", docs: { story: { inline: false } }, paperclip: { capabilities: ["agents/grok-bot"], status: "proposed", implementation: "production", boundary: "fixtures", notes: "Production configuration page with synthetic connection observations. No Grok or authorization calls." } },
} satisfies Meta<typeof Configuration>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ConnectedBot: Story = { play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  await expect(await page.findByText("Agent access connected. Routine round trip verified.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Verify connection" })).toBeVisible();
  await expect(page.queryByRole("button", { name: /^Model$/ })).not.toBeInTheDocument();
  await expect(page.queryByText("Test your agent")).not.toBeInTheDocument();
  await expect(page.queryByText("AI connection", { exact: true })).not.toBeInTheDocument();
} };
export const DisconnectedBot: Story = { args: { disconnected: true }, play: async ({ canvasElement }) => {
  const page = within(canvasElement);
  const reconnect = await page.findByRole("button", { name: "Reconnect agent access" });
  await waitFor(() => expect(reconnect).toBeEnabled());
  await userEvent.click(reconnect);
  await expect(await page.findByRole("button", { name: "Copy pairing code" })).toBeVisible();
  await expect(page.getByLabelText("One-use pairing code")).toHaveAttribute("type", "password");
  await expect(page.queryByText("synthetic-reconnect-code")).not.toBeInTheDocument();
} };
export const Mobile: Story = { ...ConnectedBot, globals: { viewport: { value: "mobile1", isRotated: false } } };
