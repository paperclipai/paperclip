import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolMcpGatewayWithTokens } from "@paperclipai/shared";
import { ToastProvider } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { GatewaysTab } from "@/pages/tools/GatewaysTab";

const COMPANY = "company-storybook";

const POPULATED: ToolMcpGatewayWithTokens[] = [
  {
    id: "gw-1",
    companyId: COMPANY,
    name: "Engineering inbox",
    slug: "engineering-inbox",
    description: "Shared MCP endpoint for the engineering org's editors and IDEs.",
    status: "active",
    profileId: "profile-eng",
    agentId: null,
    projectId: null,
    issueId: null,
    endpointPath: "/api/mcp/gateways/engineering-inbox",
    metadata: null,
    createdByAgentId: null,
    createdByUserId: "user-dotta",
    createdAt: new Date("2026-06-10T12:00:00Z"),
    updatedAt: new Date("2026-06-15T18:00:00Z"),
    tokens: [
      {
        id: "tok-1",
        companyId: COMPANY,
        gatewayId: "gw-1",
        name: "Dotta's MacBook",
        expiresAt: new Date("2026-09-01T00:00:00Z"),
        lastUsedAt: new Date("2026-06-16T08:00:00Z"),
        revokedAt: null,
        createdByAgentId: null,
        createdByUserId: "user-dotta",
        createdAt: new Date("2026-06-10T12:00:00Z"),
        updatedAt: new Date("2026-06-16T08:00:00Z"),
      },
      {
        id: "tok-2",
        companyId: COMPANY,
        gatewayId: "gw-1",
        name: "CI runner",
        expiresAt: null,
        lastUsedAt: null,
        revokedAt: null,
        createdByAgentId: null,
        createdByUserId: "user-dotta",
        createdAt: new Date("2026-06-11T09:00:00Z"),
        updatedAt: new Date("2026-06-11T09:00:00Z"),
      },
      {
        id: "tok-3",
        companyId: COMPANY,
        gatewayId: "gw-1",
        name: "Old laptop (rotated)",
        expiresAt: null,
        lastUsedAt: new Date("2026-04-01T10:00:00Z"),
        revokedAt: new Date("2026-05-15T16:00:00Z"),
        createdByAgentId: null,
        createdByUserId: "user-dotta",
        createdAt: new Date("2026-04-01T09:00:00Z"),
        updatedAt: new Date("2026-05-15T16:00:00Z"),
      },
    ],
    clientSnippets: [
      {
        client: "cursor",
        label: "Cursor",
        config: {
          mcpServers: {
            "paperclip-engineering-inbox": {
              url: "https://paperclip.app/api/mcp/gateways/engineering-inbox",
              headers: { Authorization: "Bearer YOUR_TOKEN" },
            },
          },
        },
        notes: ["Paste into ~/.cursor/mcp.json"],
      },
      {
        client: "claude_desktop",
        label: "Claude Desktop",
        config: {
          mcpServers: {
            "paperclip-engineering-inbox": {
              url: "https://paperclip.app/api/mcp/gateways/engineering-inbox",
              headers: { Authorization: "Bearer YOUR_TOKEN" },
            },
          },
        },
        notes: ["Edit ~/Library/Application Support/Claude/claude_desktop_config.json"],
      },
      {
        client: "vscode",
        label: "VS Code",
        config: {
          servers: {
            "paperclip-engineering-inbox": {
              type: "http",
              url: "https://paperclip.app/api/mcp/gateways/engineering-inbox",
              headers: { Authorization: "Bearer YOUR_TOKEN" },
            },
          },
        },
        notes: [],
      },
    ],
  } as unknown as ToolMcpGatewayWithTokens,
  {
    id: "gw-2",
    companyId: COMPANY,
    name: "Support ops (read-only)",
    slug: "support-ops",
    description: null,
    status: "active",
    profileId: "profile-support",
    agentId: null,
    projectId: null,
    issueId: null,
    endpointPath: "/api/mcp/gateways/support-ops",
    metadata: null,
    createdByAgentId: null,
    createdByUserId: "user-dotta",
    createdAt: new Date("2026-06-12T10:00:00Z"),
    updatedAt: new Date("2026-06-12T10:00:00Z"),
    tokens: [],
    clientSnippets: [
      {
        client: "claude_code",
        label: "Claude Code",
        config: {
          mcpServers: {
            "paperclip-support-ops": {
              url: "https://paperclip.app/api/mcp/gateways/support-ops",
              headers: { Authorization: "Bearer YOUR_TOKEN" },
            },
          },
        },
        notes: [],
      },
    ],
  } as unknown as ToolMcpGatewayWithTokens,
  {
    id: "gw-3",
    companyId: COMPANY,
    name: "Disabled legacy gateway with an unusually long human-readable name for truncation testing",
    slug: "legacy-long",
    description:
      "Earlier shared endpoint kept around for one Cursor user who hasn't migrated yet. Will be removed in July.",
    status: "disabled",
    profileId: "profile-legacy",
    agentId: null,
    projectId: null,
    issueId: null,
    endpointPath: "/api/mcp/gateways/legacy-very-long-slug-for-overflow-testing-of-the-mono-chip-on-mobile-and-desktop",
    metadata: null,
    createdByAgentId: null,
    createdByUserId: "user-dotta",
    createdAt: new Date("2026-03-01T10:00:00Z"),
    updatedAt: new Date("2026-06-01T10:00:00Z"),
    tokens: [
      {
        id: "tok-4",
        companyId: COMPANY,
        gatewayId: "gw-3",
        name: "Legacy IDE",
        expiresAt: new Date("2026-06-30T00:00:00Z"),
        lastUsedAt: null,
        revokedAt: null,
        createdByAgentId: null,
        createdByUserId: "user-dotta",
        createdAt: new Date("2026-03-01T10:00:00Z"),
        updatedAt: new Date("2026-03-01T10:00:00Z"),
      },
    ],
    clientSnippets: [],
  } as unknown as ToolMcpGatewayWithTokens,
];

function seededClient(gateways: ToolMcpGatewayWithTokens[]) {
  const c = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false },
    },
  });
  c.setQueryData(["tools", "gateways", COMPANY], { gateways });
  c.setQueryData(queryKeys.tools.profiles(COMPANY), {
    profiles: [
      profile("profile-eng", "Engineering", 18),
      profile("profile-support", "Support ops", 7),
      profile("profile-legacy", "Legacy read-only", 3),
    ],
  });
  c.setQueryData(queryKeys.agents.list(COMPANY), []);
  c.setQueryData(queryKeys.projects.list(COMPANY), []);
  return c;
}

function profile(id: string, name: string, allowedToolCount: number) {
  return {
    id,
    companyId: COMPANY,
    profileKey: id,
    name,
    description: null,
    status: "active",
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    entries: [],
    bindings: [],
    summary: {
      accessMode: "selected",
      allowedToolCount,
      allowedApplicationCount: 2,
      excludedToolCount: 0,
      totalToolCount: 24,
      assignmentCount: 1,
      appliesToAgentCount: 0,
      isCompanyDefault: false,
    },
  };
}

function GatewaysHost({ gateways }: { gateways: ToolMcpGatewayWithTokens[] }) {
  const client = useMemo(() => seededClient(gateways), [gateways]);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <div className="mx-auto max-w-4xl p-4 sm:p-6">
          <GatewaysTab companyId={COMPANY} />
        </div>
      </ToastProvider>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Tools/Gateways (PAP-11182)",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const Empty: Story = {
  name: "Gateways — empty state",
  render: () => <GatewaysHost gateways={[]} />,
};

export const Populated: Story = {
  name: "Gateways — populated",
  render: () => <GatewaysHost gateways={POPULATED} />,
};

export const SingleGateway: Story = {
  name: "Gateways — single gateway with no tokens",
  render: () => <GatewaysHost gateways={[POPULATED[1]]} />,
};
