import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  CONNECTABLE_APP_DEFINITIONS,
  type AppDefinition,
  type ConnectionGrant,
  type ConnectionGrantsResponse,
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
import {
  AdvancedPanel,
  ReconnectCard,
} from "@/pages/apps/app-detail/AdvancedPanel";
import { IdentitiesSection } from "@/pages/apps/app-detail/IdentitiesSection";

const COMPANY_ID = "company-storybook";
const NOTION = CONNECTABLE_APP_DEFINITIONS.find(
  (app) => app.slug === "notion",
) as AppDefinition;
const ZAPIER = CONNECTABLE_APP_DEFINITIONS.find(
  (app) => app.slug === "zapier",
) as AppDefinition;
const GITHUB = CONNECTABLE_APP_DEFINITIONS.find(
  (app) => app.slug === "github",
) as AppDefinition;

function seededClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
        refetchOnMount: false,
      },
    },
  });
  client.setQueryData(queryKeys.apps.gallery(COMPANY_ID), {
    apps: [NOTION, ZAPIER, GITHUB],
    credentialSources: {
      vercelConnect: {
        available: true,
        enabled: true,
        authentication: "access_token",
        manageUrl: "https://vercel.com/connect",
        reason: null,
      },
    },
  });
  client.setQueryData(queryKeys.tools.applications(COMPANY_ID), {
    applications: [
      {
        id: "application-notion",
        companyId: COMPANY_ID,
        name: "Notion",
        applicationKey: "notion",
        status: "active",
        metadata: {},
      },
    ],
  });
  client.setQueryData(queryKeys.tools.connections(COMPANY_ID), {
    connections: [notionConnection()],
  });
  client.setQueryData(queryKeys.access.companyUserDirectory(COMPANY_ID), {
    users: [
      {
        principalId: "board-user",
        status: "active",
        user: {
          id: "board-user",
          name: "Dotta",
          email: "dotta@example.com",
          image: null,
        },
      },
    ],
  });
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

function OAuthStateHost({
  phase,
  error,
}: {
  phase: OAuthConnectPhase;
  error?: string;
}) {
  return (
    <div className="mx-auto max-w-5xl p-6">
      <OAuthConnectStateScreen
        entry={NOTION}
        phase={phase}
        error={error}
        onRetry={() => undefined}
        onBack={() => undefined}
        onCancel={() => undefined}
      />
    </div>
  );
}

function notionConnection(
  overrides: Partial<ToolConnection> = {},
): ToolConnection {
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
    credentialSource: "paperclip_vault",
    credentialPolicy: "per_user",
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

function personalGrant(): ConnectionGrant {
  return {
    id: "grant-notion-personal",
    companyId: COMPANY_ID,
    connectionId: "connection-notion",
    kind: "user",
    subjectUserId: "board-user",
    providerTenant: { name: "Dotta" },
    credentialSecretRefs: [],
    status: "active",
    isDefault: true,
    createdByAgentId: null,
    createdByUserId: "board-user",
    revokedAt: null,
    revokedByAgentId: null,
    revokedByUserId: null,
    lastUsedAt: new Date("2026-08-06T19:00:00.000Z"),
    createdAt: new Date("2026-08-06T18:55:00.000Z"),
    updatedAt: new Date("2026-08-06T19:00:00.000Z"),
    delegations: [
      {
        id: "delegation-1",
        companyId: COMPANY_ID,
        grantId: "grant-notion-personal",
        agentId: "agent-1",
        createdByUserId: "board-user",
        createdAt: new Date("2026-08-06T19:00:00.000Z"),
      },
    ],
    capabilities: { canRevoke: true, canEditAudience: false },
  };
}

function personalGrantsResponse(
  grant: ConnectionGrant,
): ConnectionGrantsResponse {
  return {
    connection: { id: "connection-notion", uid: "notion-storybook" },
    grants: [grant],
    capabilities: {
      canConfigure: true,
      canCreateOrganizationGrant: false,
      canSetCompanyInstall: true,
      canConnectAsCurrentUser: true,
      canManageAgentInstalls: true,
      canViewOtherPersonalIdentities: false,
      editableAgentIds: ["agent-1"],
    },
    currentUserId: "board-user",
    members: [
      { userId: "board-user", name: "Dotta", email: "dotta@example.com" },
    ],
  };
}

function ConnectedHost() {
  const client = useMemo(() => seededClient(), []);
  const connection = notionConnection();
  const grant = personalGrant();
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto w-screen max-w-3xl p-6">
        <header className="mb-6 flex items-center gap-3">
          <AppLogo
            name={NOTION.name}
            logoUrl={NOTION.branding.logoUrl}
            size={44}
          />
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Notion</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Connected app setup
            </p>
          </div>
        </header>
        <div className="space-y-8">
          <SetupPanel
            connection={connection}
            galleryEntry={NOTION}
            onUpdateConfig={() => undefined}
            configUpdateDisabled={false}
            agentsSummary="1 agent"
            permissionsSummary="Allowed for 28 · Ask first for 0 · Off for 0"
            permissionsLoading={false}
            onOpenPermissions={() => undefined}
            identities={
              <IdentitiesSection
                appName="Notion"
                credentialPolicy="per_user"
                ownerUserId="board-user"
                connectedUser={{ label: "Dotta", image: null }}
                grantsQuery={personalGrantsResponse(grant)}
                loading={false}
                error={false}
                onConnectAsMe={() => undefined}
                onConnectOrganization={() => undefined}
                onReplaceAudience={() => undefined}
                connectPending={false}
                audiencePending={false}
                audienceError={null}
                audienceGrantId={null}
                onOpenAudience={() => undefined}
                onCloseAudience={() => undefined}
              />
            }
          />
          <AdvancedPanel
            connection={connection}
            appName="Notion"
            galleryEntry={NOTION}
            removing={false}
            onRemove={() => undefined}
            onReplaced={() => undefined}
            appToggleDisabled={false}
            onToggleApp={() => undefined}
            identityGrant={grant}
            identityCurrentUserId="board-user"
            identityProviderName="Notion"
            credentialPolicy="per_user"
            onReconnectIdentity={() => undefined}
            onRevokeIdentity={() => undefined}
          />
        </div>
      </div>
    </QueryClientProvider>
  );
}

function ReconnectRequiredHost() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Notion</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connection needs attention
        </p>
      </header>
      <ReconnectCard
        connection={notionConnection({
          healthStatus: "failed",
          healthMessage:
            "Notion authorization expired or was revoked (invalid_grant).",
          lastError: "invalid_grant",
        })}
        galleryEntry={NOTION}
        onReconnected={() => undefined}
      />
    </div>
  );
}

function VercelConnectProvenanceHost() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <ReconnectCard
        connection={notionConnection({
          credentialSource: "vercel_connect",
          externalCredential: {
            provider: "vercel_connect",
            connectorId: "scl_storybook",
            connectorUid: "notion-paperclip",
            service: "notion",
            connectorType: "oauth",
            principalMode: "user",
            headerName: "Authorization",
            headerPrefix: "Bearer ",
            scopes: ["*"],
          },
          healthStatus: "failed",
          healthMessage: "This Vercel Connect identity needs authorization.",
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

export const VercelConnectReconnect: Story = {
  name: "7 — Vercel Connect reconnect",
  render: () => <VercelConnectProvenanceHost />,
};
