import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CONNECTABLE_APP_DEFINITIONS,
  type AppDefinition,
  type ToolConnection,
} from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { Browse } from "@/pages/apps/Browse";
import { AppLogo } from "@/pages/apps/AppLogo";
import {
  OAuthConnectStateScreen,
  type OAuthConnectPhase,
} from "@/pages/apps/AppsConnect";
import { SetupPanel } from "@/pages/apps/app-detail/SetupPanel";
import { ReconnectCard } from "@/pages/apps/app-detail/AdvancedPanel";

const COMPANY_ID = "company-storybook";
const NOTION = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "notion") as AppDefinition;
const ZAPIER = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "zapier") as AppDefinition;
const GITHUB = CONNECTABLE_APP_DEFINITIONS.find((app) => app.slug === "github") as AppDefinition;

function seededClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false },
    },
  });
  client.setQueryData(queryKeys.apps.gallery(COMPANY_ID), { apps: [NOTION, ZAPIER, GITHUB] });
  return client;
}

function BrowseHost() {
  const client = useMemo(() => seededClient(), []);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-5xl p-6">
        <Browse />
      </div>
    </QueryClientProvider>
  );
}

function OAuthStateHost({ phase, error }: { phase: OAuthConnectPhase; error?: string }) {
  return (
    <div className="mx-auto max-w-5xl p-6">
      <OAuthConnectStateScreen
        entry={NOTION}
        phase={phase}
        error={error}
        onRetry={() => undefined}
        onCancel={() => undefined}
      />
    </div>
  );
}

function notionConnection(overrides: Partial<ToolConnection> = {}): ToolConnection {
  return {
    id: "connection-notion",
    companyId: COMPANY_ID,
    applicationId: "application-notion",
    name: "Notion",
    uid: "notion-storybook",
    connectionKind: "managed",
    ownership: "dcr",
    transport: "mcp_remote",
    authKind: "oauth",
    credentialPolicy: "per_user",
    credentialSource: "paperclip_vault",
    status: "active",
    transportConfig: { url: "https://mcp.notion.com/mcp" },
    config: {
      url: "https://mcp.notion.com/mcp",
      sourceTemplateKey: "notion",
      oauth: { provider: "notion", connectedAt: "2026-08-06T19:00:00.000Z" },
    },
    credentialSecretRefs: [],
    credentialRefs: [],
    healthStatus: "healthy",
    healthMessage: null,
    healthCheckedAt: new Date("2026-08-06T19:00:00.000Z"),
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: "board-user",
    createdAt: new Date("2026-08-06T18:55:00.000Z"),
    updatedAt: new Date("2026-08-06T19:00:00.000Z"),
    ...overrides,
  };
}

function ConnectedHost() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6 flex items-center gap-3">
        <AppLogo name={NOTION.name} logoUrl={NOTION.branding.logoUrl} size={44} />
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notion</h1>
          <p className="mt-1 text-sm text-muted-foreground">Connected app setup</p>
        </div>
      </header>
      <SetupPanel
        connection={notionConnection()}
        galleryEntry={NOTION}
        onToggleApp={() => undefined}
        appToggleDisabled={false}
        onUpdateConfig={() => undefined}
        configUpdateDisabled={false}
      />
    </div>
  );
}

function ReconnectRequiredHost() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Notion</h1>
        <p className="mt-1 text-sm text-muted-foreground">Connection needs attention</p>
      </header>
      <ReconnectCard
        connection={notionConnection({
          healthStatus: "failed",
          healthMessage: "Notion authorization expired or was revoked (invalid_grant).",
          lastError: "invalid_grant",
        })}
        galleryEntry={NOTION}
        onReconnected={() => undefined}
      />
    </div>
  );
}

const meta: Meta = {
  title: "Apps/Notion MCP connect flow (PAP-16650)",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const BrowseEntry: Story = {
  name: "1 — Browse entry",
  render: () => <BrowseHost />,
};

export const ConnectEntry: Story = {
  name: "2 — Connect entry",
  render: () => <OAuthStateHost phase="entry" />,
};

export const InFlight: Story = {
  name: "3 — In flight",
  render: () => <OAuthStateHost phase="starting" />,
};

export const Connected: Story = {
  name: "4 — Connected",
  render: () => <ConnectedHost />,
};

export const ConnectError: Story = {
  name: "5 — Connect error",
  render: () => (
    <OAuthStateHost
      phase="error"
      error="Paperclip couldn’t reach Notion’s authorization service. Check the connection and try again."
    />
  ),
};

export const ReconnectRequired: Story = {
  name: "6 — Reconnect required",
  render: () => <ReconnectRequiredHost />,
};
