import { type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { CompanySecret, ToolApplication, ToolCatalogEntry, ToolConnection } from "@paperclipai/shared";
import { ConnectionsTab } from "@/pages/tools/ConnectionsTab";
import { queryKeys } from "@/lib/queryKeys";
import { storybookSecrets } from "../fixtures/paperclipData";

const COMPANY_ID = "company-storybook";

const APPLICATIONS: ToolApplication[] = [
  {
    id: "app-github",
    companyId: COMPANY_ID,
    name: "GitHub",
    description: "Source control + issues",
    type: "mcp_http",
    status: "active",
    pluginId: null,
    ownerAgentId: null,
    ownerUserId: null,
    metadata: null,
    archivedAt: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
  },
  {
    id: "app-fs",
    companyId: COMPANY_ID,
    name: "Filesystem",
    description: "Local stdio file tools",
    type: "mcp_stdio",
    status: "active",
    pluginId: null,
    ownerAgentId: null,
    ownerUserId: null,
    metadata: null,
    archivedAt: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
  },
];

function makeConnection(overrides: Partial<ToolConnection>): ToolConnection {
  return {
    id: "conn-x",
    companyId: COMPANY_ID,
    applicationId: "app-github",
    name: "Connection",
    connectionKind: "managed",
    transport: "remote_http",
    status: "active",
    transportConfig: {},
    config: {},
    credentialSecretRefs: [],
    credentialRefs: [],
    healthStatus: "healthy",
    healthMessage: null,
    healthCheckedAt: new Date(),
    lastCatalogRefreshAt: new Date(Date.now() - 6 * 60 * 1000),
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date(Date.now() - 6 * 60 * 1000),
    ...overrides,
  };
}

const CONNECTIONS: ToolConnection[] = [
  makeConnection({
    id: "conn-github",
    applicationId: "app-github",
    name: "Production GitHub",
    transport: "remote_http",
    transportConfig: { url: "https://mcp.github.example.com/v1" },
    credentialRefs: [
      { name: "Authorization", secretId: "secret-github", version: "latest", placement: "header", key: "Authorization" },
    ],
    healthStatus: "healthy",
  }),
  makeConnection({
    id: "conn-fs",
    applicationId: "app-fs",
    name: "Workspace files",
    transport: "local_stdio",
    transportConfig: { templateId: "filesystem-readonly" },
    healthStatus: "degraded",
    healthMessage: "Discovery slow",
    lastError: "stdio handshake exceeded 2s on last probe",
    lastCatalogRefreshAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
  }),
  makeConnection({
    id: "conn-staging",
    applicationId: "app-github",
    name: "Staging GitHub (draft)",
    status: "draft",
    enabled: false,
    transportConfig: { url: "https://mcp.staging.github.example.com" },
    healthStatus: "unchecked",
    lastCatalogRefreshAt: null,
  }),
];

function catalogFor(connId: string): ToolCatalogEntry[] {
  const count = connId === "conn-github" ? 7 : connId === "conn-fs" ? 3 : 0;
  return Array.from({ length: count }, (_, i) => ({
    id: `${connId}-cat-${i}`,
    companyId: COMPANY_ID,
    applicationId: null,
    connectionId: connId,
    entryKind: "tool",
    toolName: `tool_${i}`,
    title: null,
    description: null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    riskLevel: "read",
    isReadOnly: true,
    isWrite: false,
    isDestructive: false,
    status: "active",
    version: null,
    schemaHash: null,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    reviewedAt: null,
    reviewedByAgentId: null,
    reviewedByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
}

function Fixtures({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  queryClient.setQueryData(queryKeys.tools.connections(COMPANY_ID), { connections: CONNECTIONS });
  queryClient.setQueryData(queryKeys.tools.applications(COMPANY_ID), { applications: APPLICATIONS });
  queryClient.setQueryData(queryKeys.tools.stdioTemplates(COMPANY_ID), {
    templates: [{ templateId: "filesystem-readonly", title: "Filesystem (read-only)" }],
  });
  queryClient.setQueryData(queryKeys.secrets.list(COMPANY_ID), storybookSecrets as CompanySecret[]);
  for (const c of CONNECTIONS) {
    queryClient.setQueryData(queryKeys.tools.catalog(c.id), { catalog: catalogFor(c.id) });
  }
  return <>{children}</>;
}

const meta: Meta = {
  title: "Product/Tools & Access/Connections",
  parameters: {
    layout: "fullscreen",
    a11y: { test: "off" },
  },
};

export default meta;

type Story = StoryObj;

export const ConnectionsTable: Story = {
  render: () => (
    <Fixtures>
      <div className="min-h-screen w-full bg-background p-6">
        <ConnectionsTab companyId={COMPANY_ID} />
      </div>
    </Fixtures>
  ),
};
