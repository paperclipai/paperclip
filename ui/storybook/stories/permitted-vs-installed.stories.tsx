import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Agent,
  ToolCatalogEntry,
  ToolConnection,
  ToolConnectionCapabilities,
} from "@paperclipai/shared";
import { IssueThreadInteractionCard } from "@/components/IssueThreadInteractionCard";
import {
  issueThreadInteractionFixtureMeta,
  pendingConnectionAuthorizationInteraction,
  resolvedConnectionAuthorizationInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import type { RequestConfirmationInteraction } from "@/lib/issue-thread-interactions";
import { queryKeys } from "@/lib/queryKeys";
import { AgentToolsTab } from "@/pages/AgentToolsTab";
import { PermissionsPanel } from "@/pages/apps/app-detail/PermissionsPanel";
import type { AccessDraft } from "@/pages/apps/app-detail/types";
import { AccessStep } from "@/pages/apps/AppsConnect";
import type { InstallState } from "@/lib/tool-installs";

const AGENT_IDS = ["a-sage", "a-atlas", "a-orion"];

/** A member who may configure this connection and edit every agent. */
const FULL_CAPABILITIES: ToolConnectionCapabilities = {
  canConfigure: true,
  canCreateOrganizationGrant: true,
  canSetCompanyInstall: true,
  canConnectAsCurrentUser: true,
  canManageAgentInstalls: true,
  canViewOtherPersonalIdentities: false,
  editableAgentIds: AGENT_IDS,
};

const VIEWER_CAPABILITIES: ToolConnectionCapabilities = {
  canConfigure: false,
  canCreateOrganizationGrant: false,
  canSetCompanyInstall: false,
  canConnectAsCurrentUser: false,
  canManageAgentInstalls: false,
  canViewOtherPersonalIdentities: false,
  editableAgentIds: [],
};

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

function PanelHarness({
  install,
  capabilities = FULL_CAPABILITIES,
}: {
  install: InstallState;
  capabilities?: ToolConnectionCapabilities;
}) {
  const [access, setAccess] = useState<AccessDraft>({ mode: "all", agentIds: new Set() });
  return (
    <div className="mx-auto max-w-3xl bg-background p-6">
      <PermissionsPanel
        connectionId="connection-gmail"
        capabilities={capabilities}
        appName="Gmail"
        agents={AGENTS}
        access={access}
        install={install}
        readOnly={GMAIL_TOOLS.filter((t) => t.isReadOnly)}
        canChange={GMAIL_TOOLS.filter((t) => !t.isReadOnly)}
        quarantined={[]}
        enabledIds={new Set(["g-list", "g-read"])}
        askFirstIds={new Set(["g-send"])}
        pending={false}
        refreshPending={false}
        onSaveAccess={setAccess}
        onSetActionPermission={() => {}}
        onReviewQuarantined={() => {}}
        onRefreshActions={() => {}}
      />
    </div>
  );
}

export const AppDetailAgentsIPick: Story = {
  name: "1 · App detail — Agents I pick",
  render: () => (
    <PanelHarness
      install={{ onAll: false, agentIds: new Set(["a-sage", "a-orion"]) }}
    />
  ),
};

export const AppDetailAnyAgent: Story = {
  name: "1 · App detail — Any agent",
  render: () => (
    <PanelHarness
      install={{ onAll: true, agentIds: new Set() }}
    />
  ),
};

export const AppDetailNoAgentsYet: Story = {
  name: "1 · App detail — no agents yet",
  render: () => (
    <PanelHarness
      install={{ onAll: false, agentIds: new Set() }}
    />
  ),
};

/**
 * Viewer read-only (PAP-17835). Controls are absent, not disabled: a
 * policy-forbidden action is never rendered as something to try.
 */
export const AppDetailViewerReadOnly: Story = {
  name: "1 · App detail — viewer read-only",
  render: () => (
    <PanelHarness
      install={{ onAll: false, agentIds: new Set(["a-sage"]) }}
      capabilities={VIEWER_CAPABILITIES}
    />
  ),
};

/**
 * A member who may pick agents but may not make the connection company-wide:
 * "Any agent" is omitted from the choice entirely.
 */
export const AppDetailMemberWithoutCompanyInstall: Story = {
  name: "1 · App detail — member without company-wide install",
  render: () => (
    <PanelHarness
      install={{ onAll: false, agentIds: new Set(["a-sage"]) }}
      capabilities={{ ...FULL_CAPABILITIES, canSetCompanyInstall: false }}
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

// --- Surface 3: Connect flow Access step (AccessStep) ---------------------
//
// The separate "who can use it" + "install tools" pair is gone: one Access step
// asks both questions before any credential is entered (PAP-17835).

function SeededAccessStep({
  authKind,
  initialGrantKind,
  initialChoice,
  initialAgentIds,
  capabilities = {
    canCreateOrganizationGrant: true,
    canSetCompanyInstall: true,
    editableAgentIds: AGENT_IDS,
  },
}: {
  authKind: "oauth" | "api_key" | "none";
  initialGrantKind: "user" | "organization" | "agent";
  initialChoice: "specific" | "all";
  initialAgentIds: Set<string>;
  capabilities?: {
    canCreateOrganizationGrant: boolean;
    canSetCompanyInstall: boolean;
    editableAgentIds: string[];
  };
}) {
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
    });
    c.setQueryData(queryKeys.agents.list(COMPANY), AGENTS);
    return c;
  }, []);
  const [grantKind, setGrantKind] = useState(initialGrantKind);
  const [choice, setChoice] = useState(initialChoice);
  const [ids, setIds] = useState(initialAgentIds);
  return (
    <QueryClientProvider client={client}>
      <div className="bg-background p-6">
        <AccessStep
          companyId={COMPANY}
          authKind={authKind}
          grantKind={grantKind}
          setGrantKind={setGrantKind}
          installChoice={choice}
          setInstallChoice={setChoice}
          installAgentIds={ids}
          setInstallAgentIds={setIds}
          capabilities={capabilities}
          submitLabel={authKind === "oauth" ? "Continue to Gmail" : "Save and continue"}
          onBack={() => {}}
          onContinue={() => {}}
        />
      </div>
    </QueryClientProvider>
  );
}

export const ConnectAccessJustMePickedAgents: Story = {
  name: "3 · Connect Access — Just me + Just agents I pick",
  render: () => (
    <SeededAccessStep
      authKind="oauth"
      initialGrantKind="user"
      initialChoice="specific"
      initialAgentIds={new Set(["a-sage", "a-atlas"])}
    />
  ),
};

export const ConnectAccessOrganizationAnyAgent: Story = {
  name: "3 · Connect Access — Whole organization + Any agent",
  render: () => (
    <SeededAccessStep
      authKind="api_key"
      initialGrantKind="organization"
      initialChoice="all"
      initialAgentIds={new Set()}
    />
  ),
};

/** `authKind: none` has no identity to choose, so the question is not asked. */
export const ConnectAccessNoIdentityRequired: Story = {
  name: "3 · Connect Access — no identity required",
  render: () => (
    <SeededAccessStep
      authKind="none"
      initialGrantKind="organization"
      initialChoice="specific"
      initialAgentIds={new Set(["a-sage"])}
    />
  ),
};

// --- Surface 4: the "Connect your Gmail to continue" card -------------------
//
// One `request_confirmation`, three readings (PAP-17859). The card no longer
// falls through to the generic Approve / Revise… / Reject layout: consent is
// the addressed person's alone, so the affordances change with the reader, and
// a policy-forbidden action is omitted rather than shown greyed out.

const AUTHORIZATION_USER_LABELS = new Map<string, string>([
  [issueThreadInteractionFixtureMeta.currentUserId, "Carol"],
]);

function AuthorizationCardHarness({
  interaction,
  currentUserId,
}: {
  interaction: RequestConfirmationInteraction;
  currentUserId: string;
}) {
  return (
    <div className="mx-auto max-w-3xl bg-background p-6">
      <IssueThreadInteractionCard
        interaction={interaction}
        agentMap={new Map()}
        currentUserId={currentUserId}
        userLabelMap={AUTHORIZATION_USER_LABELS}
        onAcceptInteraction={async () => {}}
        onRejectInteraction={async () => {}}
      />
    </div>
  );
}

export const AuthorizationAddressed: Story = {
  name: "4 · Connect Gmail — addressed user",
  render: () => (
    <AuthorizationCardHarness
      interaction={pendingConnectionAuthorizationInteraction}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
    />
  ),
};

export const AuthorizationOtherReader: Story = {
  name: "4 · Connect Gmail — another reader waiting",
  render: () => (
    <AuthorizationCardHarness
      interaction={pendingConnectionAuthorizationInteraction}
      currentUserId="user-someone-else"
    />
  ),
};

export const AuthorizationResolved: Story = {
  name: "4 · Connect Gmail — resolved",
  render: () => (
    <AuthorizationCardHarness
      interaction={resolvedConnectionAuthorizationInteraction}
      currentUserId={issueThreadInteractionFixtureMeta.currentUserId}
    />
  ),
};
