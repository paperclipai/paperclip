import { useMemo, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolCatalogEntry, ToolProfileSummary, ToolProfileWithDetails } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
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

const AGENTS = [
  { id: "a-sage", name: "Sage" },
  { id: "a-atlas", name: "Atlas" },
  { id: "a-nova", name: "Nova" },
];

// --- Seeded index host -----------------------------------------------------

function SeededIndex({ profiles }: { profiles: ToolProfileWithDetails[] }) {
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
    });
    c.setQueryData(queryKeys.tools.profiles(COMPANY), { profiles });
    c.setQueryData(queryKeys.tools.applications(COMPANY), { applications: [] });
    c.setQueryData(queryKeys.tools.connections(COMPANY), { connections: [] });
    c.setQueryData(queryKeys.agents.list(COMPANY), []);
    c.setQueryData(queryKeys.projects.list(COMPANY), []);
    c.setQueryData(queryKeys.routines.list(COMPANY), []);
    return c;
  }, [profiles]);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-6xl p-6">
        <ProfilesIndex companyId={COMPANY} />
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

export const IndexEmpty: Story = {
  name: "Index — empty (template cards)",
  render: () => <SeededIndex profiles={[]} />,
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
