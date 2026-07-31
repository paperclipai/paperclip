import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Agent,
  ToolCatalogEntry,
  ToolConnection,
} from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { AgentToolsTab } from "@/pages/AgentToolsTab";
import { PermissionsPanel } from "@/pages/apps/app-detail/PermissionsPanel";
import { InstallStep } from "@/pages/apps/AppsConnect";
import type { AccessDraft } from "@/pages/apps/app-detail/types";
import type { InstallState } from "@/lib/tool-installs";

// ---------------------------------------------------------------------------
// Phase 3b — Permitted vs Installed UX review harness (PAP-13634).
// Renders the three changed surfaces at a real viewport so visual craft can be
// signed off. Fixtures are self-contained; casts keep the stories terse.
// ---------------------------------------------------------------------------

const COMPANY = "company-review";

const AGENTS: Agent[] = [
  { id: "a-sage", name: "Sage", status: "active" },
  { id: "a-atlas", name: "Atlas", status: "active" },
  { id: "a-nova", name: "Nova", status: "active" },
  { id: "a-orion", name: "Orion", status: "active" },
] as unknown as Agent[];

function tool(
  id: string,
  toolName: string,
  cap: "read" | "write" | "destructive",
  title: string,
  connectionId: string,
): ToolCatalogEntry {
  return {
    id,
    companyId: COMPANY,
    applicationId: "app-gmail",
    connectionId,
    entryKind: "tool",
    toolName,
    title,
    description: title,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    riskLevel: cap,
    isReadOnly: cap === "read",
    isWrite: cap === "write",
    isDestructive: cap === "destructive",
    status: "active",
    addedAt: new Date("2026-06-01T00:00:00Z"),
    version: null,
    schemaHash: null,
    firstSeenAt: new Date("2026-06-01T00:00:00Z"),
    lastSeenAt: new Date("2026-06-01T00:00:00Z"),
    reviewedAt: null,
  } as unknown as ToolCatalogEntry;
}

const GMAIL_TOOLS = [
  tool("g-list", "gmail.list", "read", "List messages", "conn-gmail"),
  tool("g-read", "gmail.read", "read", "Read message", "conn-gmail"),
  tool("g-send", "gmail.send", "write", "Send message", "conn-gmail"),
];
const SLACK_TOOLS = [tool("s-list", "slack.list", "read", "List channels", "conn-slack")];

function connection(id: string, name: string, installs: InstallState): ToolConnection {
  const rows = [
    ...(installs.onAll ? [{ targetType: "company", targetId: COMPANY }] : []),
    ...[...installs.agentIds].map((targetId) => ({ targetType: "agent", targetId })),
  ].map((r, i) => ({
    id: `${id}-install-${i}`,
    companyId: COMPANY,
    connectionId: id,
    ...r,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
  }));
  return {
    id,
    companyId: COMPANY,
    name,
    status: "active",
    installs: rows,
  } as unknown as ToolConnection;
}

const meta: Meta = {
  title: "Tools/Permitted vs Installed",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

// --- Surface 1: App detail Permissions tab (PermissionsPanel) --------------

function PanelHarness({ access, install }: { access: AccessDraft; install: InstallState }) {
  const [state, setState] = useState(install);
  return (
    <div className="mx-auto max-w-3xl bg-background p-6">
      <PermissionsPanel
        appName="Gmail"
        access={access}
        agents={AGENTS}
        install={state}
        readOnly={GMAIL_TOOLS.filter((t) => t.isReadOnly)}
        canChange={GMAIL_TOOLS.filter((t) => !t.isReadOnly)}
        quarantined={[]}
        enabledIds={new Set(["g-list", "g-read"])}
        askFirstIds={new Set(["g-send"])}
        pending={false}
        installPending={false}
        refreshPending={false}
        onSaveAccess={() => {}}
        onSaveInstall={setState}
        onSetActionPermission={() => {}}
        onTurnOnQuarantined={() => {}}
        onRefreshActions={() => {}}
      />
    </div>
  );
}

export const AppDetailInstalledMixed: Story = {
  name: "1 · App detail — mixed install + auto-extend warning",
  render: () => (
    <PanelHarness
      access={{ mode: "specific", agentIds: new Set(["a-sage", "a-atlas"]) }}
      install={{ onAll: false, agentIds: new Set(["a-sage", "a-orion"]) }}
    />
  ),
};

export const AppDetailInstalledOnAll: Story = {
  name: "1 · App detail — installed on all agents",
  render: () => (
    <PanelHarness
      access={{ mode: "all", agentIds: new Set() }}
      install={{ onAll: true, agentIds: new Set() }}
    />
  ),
};

export const AppDetailPermittedOnly: Story = {
  name: "1 · App detail — permitted only (not installed)",
  render: () => (
    <PanelHarness
      access={{ mode: "all", agentIds: new Set() }}
      install={{ onAll: false, agentIds: new Set() }}
    />
  ),
};

// --- Surface 2: Agent detail Tools tab (AgentToolsTab) ---------------------

function SeededAgentTools() {
  const allowed = [...GMAIL_TOOLS, SLACK_TOOLS[0]];
  const connections = [
    connection("conn-gmail", "Gmail", { onAll: false, agentIds: new Set(["a-sage"]) }),
    connection("conn-slack", "Slack", { onAll: false, agentIds: new Set() }),
  ];
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
    });
    c.setQueryData(queryKeys.tools.effectiveProfilesForAgent(COMPANY, "a-sage"), {
      agentId: "a-sage",
      profiles: [],
      bindings: [],
      allowedTools: allowed,
      allowedToolNames: allowed.map((t) => t.toolName),
      installedConnections: connections.filter((conn) => conn.id === "conn-gmail"),
    });
    c.setQueryData(queryKeys.tools.connections(COMPANY), { connections });
    c.setQueryData(queryKeys.tools.catalog("conn-gmail"), { catalog: GMAIL_TOOLS });
    c.setQueryData(queryKeys.tools.catalog("conn-slack"), { catalog: SLACK_TOOLS });
    return c;
  }, []);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-6xl bg-background p-6">
        <AgentToolsTab agent={{ id: "a-sage", name: "Sage" } as never} companyId={COMPANY} />
      </div>
    </QueryClientProvider>
  );
}

export const AgentToolsInstalledApps: Story = {
  name: "2 · Agent Tools tab — Installed apps + badges",
  render: () => <SeededAgentTools />,
};

// --- Surface 3: Connect flow Install step (InstallStep) --------------------

function SeededInstallStep({
  access,
  accessAgentIds,
  initialMode,
  initialInstall,
}: {
  access: "all" | "specific";
  accessAgentIds: Set<string>;
  initialMode: "none" | "specific" | "all";
  initialInstall: Set<string>;
}) {
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
    });
    c.setQueryData(queryKeys.agents.list(COMPANY), AGENTS);
    return c;
  }, []);
  const [mode, setMode] = useState(initialMode);
  const [ids, setIds] = useState(initialInstall);
  return (
    <QueryClientProvider client={client}>
      <div className="bg-background p-6">
        <InstallStep
          appName="Gmail"
          companyId={COMPANY}
          access={access}
          accessAgentIds={accessAgentIds}
          installMode={mode}
          setInstallMode={setMode}
          installAgentIds={ids}
          setInstallAgentIds={setIds}
          submitting={false}
          onBack={() => {}}
          onFinish={() => {}}
        />
      </div>
    </QueryClientProvider>
  );
}

export const ConnectInstallSpecific: Story = {
  name: "3 · Connect — Install step (specific + auto-extend)",
  render: () => (
    <SeededInstallStep
      access="specific"
      accessAgentIds={new Set(["a-sage", "a-atlas"])}
      initialMode="specific"
      initialInstall={new Set(["a-sage", "a-orion"])}
    />
  ),
};

export const ConnectInstallAll: Story = {
  name: "3 · Connect — Install step (all agents)",
  render: () => (
    <SeededInstallStep
      access="all"
      accessAgentIds={new Set()}
      initialMode="all"
      initialInstall={new Set()}
    />
  ),
};
