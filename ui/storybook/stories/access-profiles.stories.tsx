import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ToolCatalogEntry,
  ToolConnection,
  ToolPolicy,
  ToolProfileEffectiveSummary,
  ToolProfileNewToolsReview,
  ToolProfileSummary,
  ToolProfileWithDetails,
} from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { AgentToolsTab } from "@/pages/AgentToolsTab";
import { ProfileDetail } from "@/pages/tools/profiles/ProfileDetail";
import { ProfilesIndex } from "@/pages/tools/profiles/ProfilesIndex";
import { StepAssign, StepName } from "@/pages/tools/profiles/ProfileWizard";
import { WizardToolsStep } from "@/pages/tools/profiles/WizardToolsStep";
import {
  groupCatalogByApp,
  TEMPLATES,
  type AdvancedRule,
  type WizardSelections,
} from "@/pages/tools/profiles/profile-model";

const COMPANY = "company-storybook";

// --- Catalog fixtures ------------------------------------------------------

function makeTool(
  id: string,
  toolName: string,
  cap: "read" | "write" | "destructive",
  title: string,
  applicationId: string,
  connectionId: string,
): ToolCatalogEntry {
  return {
    id,
    companyId: COMPANY,
    applicationId,
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
    reviewedByAgentId: null,
    reviewedByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  } as ToolCatalogEntry;
}

const GMAIL_TOOLS: ToolCatalogEntry[] = [
  makeTool("g-list", "gmail.list_messages", "read", "List messages in a mailbox", "app-gmail", "conn-gmail"),
  makeTool("g-read", "gmail.get_message", "read", "Read a single message", "app-gmail", "conn-gmail"),
  makeTool("g-search", "gmail.search", "read", "Search the mailbox", "app-gmail", "conn-gmail"),
  makeTool("g-labels", "gmail.list_labels", "read", "List labels", "app-gmail", "conn-gmail"),
  makeTool("g-draft", "gmail.create_draft", "write", "Create a draft", "app-gmail", "conn-gmail"),
  makeTool("g-send", "gmail.send_message", "write", "Send a message", "app-gmail", "conn-gmail"),
  makeTool("g-label", "gmail.modify_labels", "write", "Add or remove labels", "app-gmail", "conn-gmail"),
  makeTool("g-archive", "gmail.archive", "write", "Archive a thread", "app-gmail", "conn-gmail"),
  makeTool("g-trash", "gmail.trash_message", "destructive", "Move a message to trash", "app-gmail", "conn-gmail"),
  makeTool("g-delete", "gmail.delete_message", "destructive", "Permanently delete a message", "app-gmail", "conn-gmail"),
  makeTool("g-purge", "gmail.empty_trash", "destructive", "Empty the trash", "app-gmail", "conn-gmail"),
  makeTool("g-filter", "gmail.delete_filter", "destructive", "Delete a filter", "app-gmail", "conn-gmail"),
];

const SLACK_TOOLS: ToolCatalogEntry[] = [
  makeTool("s-list", "slack.list_channels", "read", "List channels", "app-slack", "conn-slack"),
  makeTool("s-history", "slack.channel_history", "read", "Read channel history", "app-slack", "conn-slack"),
  makeTool("s-post", "slack.post_message", "write", "Post a message", "app-slack", "conn-slack"),
  makeTool("s-archive", "slack.archive_channel", "destructive", "Archive a channel", "app-slack", "conn-slack"),
];

const CATALOG = [...GMAIL_TOOLS, ...SLACK_TOOLS];

const APP_GROUPS = groupCatalogByApp(
  CATALOG,
  new Map([
    ["app-gmail", "Gmail"],
    ["app-slack", "Slack"],
  ]),
  new Map([
    ["conn-gmail", "Gmail"],
    ["conn-slack", "Slack"],
  ]),
);

// --- Profile fixtures ------------------------------------------------------

function summary(partial: Partial<ToolProfileSummary>): ToolProfileSummary {
  return {
    accessMode: "selected",
    allowedToolCount: 0,
    allowedApplicationCount: 0,
    excludedToolCount: 0,
    totalToolCount: 16,
    assignmentCount: 0,
    appliesToAgentCount: 0,
    isCompanyDefault: false,
    ...partial,
  };
}

function profile(
  id: string,
  name: string,
  status: ToolProfileWithDetails["status"],
  s: Partial<ToolProfileSummary>,
  updatedAt: string,
): ToolProfileWithDetails {
  return {
    id,
    companyId: COMPANY,
    profileKey: id,
    name,
    description: null,
    status,
    defaultAction: "deny",
    newToolsReviewedAt: null,
    metadata: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date(updatedAt),
    entries: [],
    bindings: [],
    summary: summary(s),
  };
}

const PROFILES: ToolProfileWithDetails[] = [
  profile("read-only", "Read-only starter", "active", { allowedToolCount: 6, allowedApplicationCount: 0, appliesToAgentCount: 3 }, "2026-06-11T10:00:00Z"),
  profile("everyday", "Everyday work", "active", { allowedToolCount: 12, allowedApplicationCount: 1, appliesToAgentCount: 2 }, "2026-06-12T09:00:00Z"),
  profile("company-baseline", "Company baseline", "active", { accessMode: "all_except", excludedToolCount: 4, isCompanyDefault: true }, "2026-06-09T14:00:00Z"),
  profile("marketing", "Marketing reach", "active", { allowedToolCount: 3, allowedApplicationCount: 0 }, "2026-06-10T08:00:00Z"),
  profile("half-built", "Onboarding bot access", "draft", { allowedToolCount: 2 }, "2026-06-12T16:30:00Z"),
];

const DETAIL_PROFILE: ToolProfileWithDetails = {
  ...profile("detail", "Everyday work", "active", { allowedToolCount: 12, allowedApplicationCount: 1, appliesToAgentCount: 2, assignmentCount: 2 }, "2026-06-12T09:00:00Z"),
  description: "Read and make routine changes across connected work apps.",
  entries: [
    {
      id: "entry-gmail",
      companyId: COMPANY,
      profileId: "detail",
      selectorType: "application",
      effect: "include",
      applicationId: "app-gmail",
      connectionId: null,
      catalogEntryId: null,
      toolName: null,
      riskLevel: null,
      conditions: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-01T00:00:00Z"),
    },
  ],
  bindings: [
    {
      id: "bind-sage",
      companyId: COMPANY,
      profileId: "detail",
      targetType: "agent",
      targetId: "a-sage",
      priority: 0,
      metadata: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-01T00:00:00Z"),
    },
    {
      id: "bind-atlas",
      companyId: COMPANY,
      profileId: "detail",
      targetType: "agent",
      targetId: "a-atlas",
      priority: 0,
      metadata: null,
      createdByAgentId: null,
      createdByUserId: null,
      createdAt: new Date("2026-06-01T00:00:00Z"),
      updatedAt: new Date("2026-06-01T00:00:00Z"),
    },
  ],
};

const NEW_TOOLS_PROFILE: ToolProfileWithDetails = {
  ...DETAIL_PROFILE,
  id: "gmail-new-tools",
  name: "Gmail everyday",
  newToolsPendingCount: 3,
};

const AUTO_ALLOW_PROFILE: ToolProfileWithDetails = {
  ...DETAIL_PROFILE,
  id: "gmail-auto-allow",
  name: "Gmail auto-allow",
  defaultAction: "allow",
};

const NEW_TOOLS_REVIEW: ToolProfileNewToolsReview = {
  profileId: NEW_TOOLS_PROFILE.id,
  reviewedAt: new Date("2026-05-01T00:00:00Z"),
  pendingCount: 3,
  tools: [
    {
      catalogEntryId: "g-send",
      applicationId: "app-gmail",
      applicationName: "Gmail",
      connectionId: "conn-gmail",
      connectionName: "Gmail",
      toolName: "gmail.send_message",
      title: "Send a message",
      description: "Send a message from Gmail.",
      capability: "write",
      riskLevel: "write",
      addedAt: new Date("2026-05-28T00:00:00Z"),
      firstSeenAt: new Date("2026-05-28T00:00:00Z"),
    },
    {
      catalogEntryId: "g-label",
      applicationId: "app-gmail",
      applicationName: "Gmail",
      connectionId: "conn-gmail",
      connectionName: "Gmail",
      toolName: "gmail.modify_labels",
      title: "Add or remove labels",
      description: "Apply labels to existing messages.",
      capability: "write",
      riskLevel: "write",
      addedAt: new Date("2026-05-28T00:00:00Z"),
      firstSeenAt: new Date("2026-05-28T00:00:00Z"),
    },
    {
      catalogEntryId: "g-trash",
      applicationId: "app-gmail",
      applicationName: "Gmail",
      connectionId: "conn-gmail",
      connectionName: "Gmail",
      toolName: "gmail.trash_message",
      title: "Move a message to trash",
      description: "Move a message out of the inbox and into trash.",
      capability: "destructive",
      riskLevel: "destructive",
      addedAt: new Date("2026-05-28T00:00:00Z"),
      firstSeenAt: new Date("2026-05-28T00:00:00Z"),
    },
  ],
};

const CONNECTIONS: ToolConnection[] = [
  {
    id: "conn-gmail",
    companyId: COMPANY,
    applicationId: "app-gmail",
    name: "Gmail",
    connectionKind: "managed",
    status: "active",
    transportConfig: {},
    credentialSecretRefs: [],
    healthStatus: "ok",
    healthCheckedAt: null,
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  } as ToolConnection,
  {
    id: "conn-slack",
    companyId: COMPANY,
    applicationId: "app-slack",
    name: "Slack",
    connectionKind: "managed",
    status: "active",
    transportConfig: {},
    credentialSecretRefs: [],
    healthStatus: "ok",
    healthCheckedAt: null,
    lastError: null,
    enabled: true,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  } as ToolConnection,
];

const AGENTS = [
  { id: "a-sage", name: "Sage" },
  { id: "a-atlas", name: "Atlas" },
  { id: "a-nova", name: "Nova" },
];

// --- Seeded index host -----------------------------------------------------

function SeededIndex({
  profiles,
  initialStatusFilter,
  initialResolverOpen,
}: {
  profiles: ToolProfileWithDetails[];
  initialStatusFilter?: "active" | "archived";
  initialResolverOpen?: boolean;
}) {
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
    });
    c.setQueryData(queryKeys.tools.profiles(COMPANY), { profiles });
    c.setQueryData(queryKeys.tools.applications(COMPANY), { applications: [] });
    c.setQueryData(queryKeys.tools.connections(COMPANY), { connections: [] });
    c.setQueryData(queryKeys.agents.list(COMPANY), AGENTS);
    c.setQueryData(queryKeys.tools.effectiveProfilesForAgent(COMPANY, "a-sage"), {
      agentId: "a-sage",
      profiles: [DETAIL_PROFILE],
      entries: DETAIL_PROFILE.entries,
      bindings: DETAIL_PROFILE.bindings,
      allowedTools: GMAIL_TOOLS.slice(0, 4),
      allowedToolNames: GMAIL_TOOLS.slice(0, 4).map((tool) => tool.toolName),
    } satisfies ToolProfileEffectiveSummary);
    c.setQueryData(queryKeys.projects.list(COMPANY), []);
    c.setQueryData(queryKeys.routines.list(COMPANY), []);
    return c;
  }, [profiles]);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-6xl p-6">
        <ProfilesIndex
          companyId={COMPANY}
          initialStatusFilter={initialStatusFilter}
          initialResolverOpen={initialResolverOpen}
        />
      </div>
    </QueryClientProvider>
  );
}

function SeededDetail({
  profile,
  catalog = CATALOG,
  connections = CONNECTIONS,
  initialCreated,
  initialReviewOpen,
}: {
  profile: ToolProfileWithDetails;
  catalog?: ToolCatalogEntry[];
  connections?: ToolConnection[];
  initialCreated?: boolean;
  initialReviewOpen?: boolean;
}) {
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
    });
    c.setQueryData(queryKeys.tools.profiles(COMPANY), { profiles: [profile, ...PROFILES] });
    c.setQueryData(queryKeys.tools.applications(COMPANY), {
      applications: [
        { id: "app-gmail", name: "Gmail" },
        { id: "app-slack", name: "Slack" },
      ],
    });
    c.setQueryData(queryKeys.tools.connections(COMPANY), { connections });
    c.setQueryData(queryKeys.tools.catalog("conn-gmail"), { catalog: catalog.filter((tool) => tool.connectionId === "conn-gmail") });
    c.setQueryData(queryKeys.tools.catalog("conn-slack"), { catalog: catalog.filter((tool) => tool.connectionId === "conn-slack") });
    c.setQueryData(queryKeys.tools.profileNewTools(profile.id), profile.newToolsPendingCount ? NEW_TOOLS_REVIEW : { profileId: profile.id, reviewedAt: null, pendingCount: 0, tools: [] });
    c.setQueryData(queryKeys.agents.list(COMPANY), AGENTS);
    c.setQueryData(queryKeys.projects.list(COMPANY), []);
    c.setQueryData(queryKeys.routines.list(COMPANY), []);
    return c;
  }, [profile, catalog, connections]);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-6xl p-6">
        <ProfileDetail
          companyId={COMPANY}
          profileId={profile.id}
          initialCreated={initialCreated}
          initialReviewOpen={initialReviewOpen}
        />
      </div>
    </QueryClientProvider>
  );
}

function SeededAgentTools() {
  const allowed = GMAIL_TOOLS.slice(0, 6);
  const policy: ToolPolicy = {
    id: "policy-write",
    companyId: COMPANY,
    name: "Ask first for sending mail",
    description: "Write tools need a quick human OK.",
    policyType: "require_approval",
    priority: 10,
    enabled: true,
    selectors: {},
    conditions: null,
    config: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  };
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
    });
    c.setQueryData(queryKeys.tools.effectiveProfilesForAgent(COMPANY, "a-sage"), {
      agentId: "a-sage",
      profiles: [{ ...DETAIL_PROFILE, summary: summary({ allowedToolCount: allowed.length, allowedApplicationCount: 1, assignmentCount: 1, appliesToAgentCount: 1, isCompanyDefault: true }) }],
      entries: DETAIL_PROFILE.entries,
      bindings: DETAIL_PROFILE.bindings,
      allowedTools: allowed,
      allowedToolNames: allowed.map((tool) => tool.toolName),
    } satisfies ToolProfileEffectiveSummary);
    c.setQueryData(queryKeys.tools.connections(COMPANY), { connections: CONNECTIONS });
    c.setQueryData(queryKeys.tools.catalog("conn-gmail"), { catalog: GMAIL_TOOLS });
    c.setQueryData(queryKeys.tools.catalog("conn-slack"), { catalog: SLACK_TOOLS });
    c.setQueryData(queryKeys.tools.policies(COMPANY), { policies: [policy] });
    return c;
  }, [allowed, policy]);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-6xl p-6">
        <AgentToolsTab agent={{ id: "a-sage", name: "Sage" } as never} companyId={COMPANY} />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Tools/Access profiles",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const IndexPopulated: Story = {
  name: "Index — populated",
  render: () => <SeededIndex profiles={PROFILES} />,
};

export const IndexNewToolsChip: Story = {
  name: "Index — new tools chip (AP1 v2)",
  render: () => <SeededIndex profiles={[NEW_TOOLS_PROFILE, ...PROFILES]} />,
};

export const AccessCheckerSheet: Story = {
  name: "Access checker sheet (AP8)",
  render: () => <SeededIndex profiles={PROFILES} initialResolverOpen />,
};

export const IndexEmpty: Story = {
  name: "Index — empty (template cards)",
  render: () => <SeededIndex profiles={[]} />,
};

export const IndexArchived: Story = {
  name: "Index — archived filter",
  render: () => <SeededIndex initialStatusFilter="archived" profiles={[...PROFILES, profile("old-profile", "Archived profile", "archived", { allowedToolCount: 5, assignmentCount: 1 }, "2026-06-08T10:00:00Z")]} />,
};

export const DetailAssigned: Story = {
  name: "Detail — assigned",
  render: () => <SeededDetail profile={DETAIL_PROFILE} />,
};

export const DetailNewToolsBanner: Story = {
  name: "Detail — new tools banner (AP16)",
  render: () => <SeededDetail profile={NEW_TOOLS_PROFILE} />,
};

export const DetailNewToolsModal: Story = {
  name: "Detail — new tools review modal (AP16)",
  render: () => <SeededDetail profile={NEW_TOOLS_PROFILE} initialReviewOpen />,
};

export const DetailAutoAllowedRows: Story = {
  name: "Detail — auto-added row notes (AP16b)",
  render: () => <SeededDetail profile={AUTO_ALLOW_PROFILE} />,
};

export const AgentAccessProfilesCard: Story = {
  name: "Agent page — access profiles card (AP19)",
  render: () => <SeededAgentTools />,
};

export const DetailUnassignedPostCreate: Story = {
  name: "Detail — unassigned post-create",
  render: () => (
    <SeededDetail
      initialCreated
      profile={{
        ...DETAIL_PROFILE,
        id: "detail-unassigned",
        bindings: [],
        summary: summary({ allowedToolCount: 12, allowedApplicationCount: 1, assignmentCount: 0, appliesToAgentCount: 0 }),
      }}
    />
  ),
};

export const DetailArchived: Story = {
  name: "Detail — archived",
  render: () => (
    <SeededDetail
      profile={{
        ...DETAIL_PROFILE,
        id: "detail-archived",
        status: "archived",
      }}
    />
  ),
};

export const DetailDegraded: Story = {
  name: "Detail — degraded",
  render: () => (
    <SeededDetail
      profile={{
        ...DETAIL_PROFILE,
        id: "detail-degraded",
        summary: summary({ allowedToolCount: 12, allowedApplicationCount: 1, appliesToAgentCount: 2, assignmentCount: 2 }),
      }}
      connections={[{ ...CONNECTIONS[0], status: "disabled", healthStatus: "error" } as ToolConnection, CONNECTIONS[1]]}
    />
  ),
};

export const WizardStep1: Story = {
  name: "Wizard — step 1 (Name)",
  render: function Step1() {
    const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["key"] | null>("everyday");
    const [name, setName] = useState("Everyday work");
    const [description, setDescription] = useState("Read and make routine changes — no destructive tools.");
    const [profileKey, setProfileKey] = useState("everyday");
    return (
      <div className="mx-auto max-w-3xl p-6">
        <StepName
          template={template}
          onTemplate={setTemplate}
          copyFromId={null}
          onCopyFrom={() => {}}
          copyOptions={PROFILES.filter((p) => p.status !== "draft")}
          name={name}
          onName={setName}
          description={description}
          onDescription={setDescription}
          profileKey={profileKey}
          onProfileKey={setProfileKey}
        />
      </div>
    );
  },
};

export const WizardStep2: Story = {
  name: "Wizard — step 2 (Choose tools)",
  render: function Step2() {
    const [selections, setSelections] = useState<WizardSelections>({
      "app-gmail": { kind: "all" },
      "app-slack": { kind: "some", included: ["s-list", "s-history"] },
    });
    const [rules, setRules] = useState<AdvancedRule[]>([]);
    const [action, setAction] = useState<"deny" | "allow">("deny");
    return (
      <div className="mx-auto max-w-3xl p-6">
        <WizardToolsStep
          appGroups={APP_GROUPS}
          catalogLoading={false}
          selections={selections}
          onSelectionsChange={setSelections}
          advancedRules={rules}
          onAdvancedRulesChange={setRules}
          newToolsAction={action}
          onNewToolsActionChange={setAction}
        />
      </div>
    );
  },
};

export const WizardStep2Partial: Story = {
  name: "Wizard — step 2 partial selection (AP4b)",
  render: function Step2Partial() {
    const [selections, setSelections] = useState<WizardSelections>({
      "app-gmail": { kind: "all_except", excluded: ["g-delete", "g-purge"] },
      "app-slack": { kind: "all" },
    });
    const [rules, setRules] = useState<AdvancedRule[]>([
      { id: "r1", kind: "risk_level", value: "destructive", riskLevel: "destructive", effect: "exclude" },
    ]);
    const [action, setAction] = useState<"deny" | "allow">("deny");
    return (
      <div className="mx-auto max-w-3xl p-6">
        <WizardToolsStep
          appGroups={APP_GROUPS}
          catalogLoading={false}
          selections={selections}
          onSelectionsChange={setSelections}
          advancedRules={rules}
          onAdvancedRulesChange={setRules}
          newToolsAction={action}
          onNewToolsActionChange={setAction}
        />
      </div>
    );
  },
};

export const WizardStep3: Story = {
  name: "Wizard — step 3 (Assign)",
  render: function Step3() {
    const [selected, setSelected] = useState<Set<string>>(new Set(["a-sage"]));
    const [companyDefault, setCompanyDefault] = useState(false);
    return (
      <div className="mx-auto max-w-3xl p-6">
        <StepAssign
          agents={AGENTS}
          profiles={PROFILES}
          selectedAgentIds={selected}
          onToggleAgent={(id) =>
            setSelected((prev) => {
              const next = new Set(prev);
              next.has(id) ? next.delete(id) : next.add(id);
              return next;
            })
          }
          companyDefault={companyDefault}
          onCompanyDefault={setCompanyDefault}
        />
      </div>
    );
  },
};
