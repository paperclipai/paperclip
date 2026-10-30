import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { getAppStoreDefinition, type ToolApplication, type ToolConnection } from "@paperclipai/shared";
import { ManagedAiConnectionRow } from "@/components/ai-connections/ManagedAiConnectionDetails";
import { ConnectorCard } from "@/pages/apps/Browse";
import type { ComponentProps } from "react";

type Row = ComponentProps<typeof ConnectorCard>["row"];

const PROFILES = new Map([
  ["user-dotta", { label: "Dotta B", image: null }],
  ["user-nicky", { label: "Nicky Paperclip Admin", image: null }],
  ["user-devin", { label: "Devin Foley", image: null }],
  ["user-scott", { label: "Scott", image: null }],
]);

function aiConnection(id: string, name: string, owner: string, provider: "openai" | "anthropic", method: "api_key" | "subscription",
  shared: boolean, overrides: Partial<ToolConnection> = {}): ToolConnection {
  return {
    id, companyId: "company-storybook", applicationId: `app-${provider}`, uid: id, name,
    connectionKind: "managed", connectionPurpose: "ai", ownership: "customer", transport: "http", authKind: method === "api_key" ? "api_key" : "oauth",
    credentialSource: "paperclip_vault", credentialPolicy: shared ? "shared" : "per_user", status: "active", enabled: true,
    config: { sourceTemplateKey: provider, aiIsolatedSubscription: true, ai: { provider, method } }, transportConfig: {}, credentialSecretRefs: [],
    healthStatus: "ok", healthCheckedAt: new Date(), lastError: null, createdByAgentId: null, createdByUserId: owner,
    createdAt: new Date(), updatedAt: new Date(), ...overrides,
  } as ToolConnection;
}

const OPENAI_ACCOUNTS = [
  aiConnection("dotta-key", "Dotta's OpenAI API Key", "user-dotta", "openai", "api_key", false),
  aiConnection("nicky-sub", "Nicky’s OpenAI", "user-nicky", "openai", "subscription", true),
  aiConnection("devin-sub", "Devin’s OpenAI", "user-devin", "openai", "subscription", true),
  aiConnection("dotta-openai", "Dotta’s OpenAI", "user-dotta", "openai", "api_key", false),
  aiConnection("scott-sub", "Scott's ChatGPT subscription account", "user-scott", "openai", "subscription", false),
];

function providerRow(slug: string, connections: ToolConnection[]): Row {
  const entry = getAppStoreDefinition(slug)!;
  const application: ToolApplication = {
    id: `app-${slug}`, companyId: "company-storybook", name: entry.name, description: entry.description, type: "mcp_http",
    status: "active", pluginId: null, ownerAgentId: null, ownerUserId: null, metadata: { sourceTemplateKey: slug },
    archivedAt: null, createdAt: new Date(), updatedAt: new Date(),
  };
  return {
    key: `native:${slug}`, slug, name: entry.name, description: entry.description, brandKey: slug, entry,
    connections, applications: [application], chatEndpoints: [], logoUrl: entry.branding?.logoUrl, darkLogoUrl: entry.branding?.darkLogoUrl,
  };
}

/** Design review: the shipped Apps page card with local example accounts. */
function ConnectionCountToggleReview({ rows, defaultExpanded = false }: { rows: Row[]; defaultExpanded?: boolean }) {
  return <main className="mx-auto flex max-w-3xl flex-col gap-3 p-4 sm:p-6" role="list">
    {rows.map(row => <ConnectorCard key={row.key} row={row} userProfileById={PROFILES} chatConnectorsEnabled
      defaultExpanded={defaultExpanded} onNavigate={() => {}} onRequestRemove={() => {}}
      renderAccountDetails={connection => <ManagedAiConnectionRow connection={connection} />} />)}
  </main>;
}

const meta = {
  id: "apps-connection-count-toggle",
  title: "Apps, channels, and extensions/Connection setup/Connection count toggle",
  component: ConnectionCountToggleReview,
  parameters: {
    layout: "fullscreen",
    paperclip: {
      capabilities: ["connection-setup/catalog", "app-permissions/account-maintenance"],
      status: "current",
      implementation: "production",
      boundary: "fixtures",
      notes: "Uses ConnectorCard with local account fixtures. Covers collapsed, expanded, needs-attention, unfinished chat setup, search, single-account and overview states. Navigation and account mutation callbacks are simulated; provider access and persistence are not exercised.",
    },
  },
} satisfies Meta<typeof ConnectionCountToggleReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Collapsed: Story = { args: { rows: [providerRow("openai", OPENAI_ACCOUNTS)] } };

export const Expanded: Story = {
  args: Collapsed.args,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: /5 connections/ }));
    await expect(within(canvasElement).getByText("Scott's ChatGPT subscription account")).toBeVisible();
  },
};

export const NeedsAttention: Story = {
  args: { rows: [providerRow("openai", OPENAI_ACCOUNTS.map(connection => connection.id === "devin-sub"
    ? { ...connection, healthStatus: "error", healthMessage: "Sign in again to restore access." } as ToolConnection : connection))] },
};

export const SearchMatch: Story = { args: { rows: Collapsed.args.rows, defaultExpanded: true } };

export const UnfinishedChatSetup: Story = {
  args: { rows: [{
    ...providerRow("slack", []),
    chatEndpoints: [
      { id: "slack-active", companyId: "company-storybook", provider: "slack", status: "active",
        assignedAgentId: "active-agent", assignedAgentName: "Active agent", allowUnlinkedPeople: false },
      { id: "slack-verifying", companyId: "company-storybook", provider: "slack", status: "verifying",
        assignedAgentId: "setup-agent", assignedAgentName: "Setup agent", allowUnlinkedPeople: false,
        setup: { step: "provider_setup" } },
    ],
  }] },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("button", { name: /2 connections/ })).toHaveAttribute("aria-expanded", "true");
    await expect(within(canvasElement).getByRole("button", { name: "Finish setup" })).toBeVisible();
  },
};

export const SingleConnection: Story = {
  args: { rows: [providerRow("anthropic", [aiConnection("dotta-claude", "Dotta’s Claude", "user-dotta", "anthropic", "subscription", false)])] },
};

export const PageOverview: Story = {
  args: { rows: [
    providerRow("anthropic", [aiConnection("dotta-claude", "Dotta’s Claude", "user-dotta", "anthropic", "subscription", false)]),
    providerRow("openai", OPENAI_ACCOUNTS),
    providerRow("openrouter", [
      aiConnection("router-team", "Team OpenRouter", "user-nicky", "openai", "api_key", true, { config: { sourceTemplateKey: "openrouter", ai: { provider: "openai", method: "api_key" } } }),
      aiConnection("router-devin", "Devin’s OpenRouter", "user-devin", "openai", "api_key", false, { config: { sourceTemplateKey: "openrouter", ai: { provider: "openai", method: "api_key" } } }),
    ]),
  ] },
};
