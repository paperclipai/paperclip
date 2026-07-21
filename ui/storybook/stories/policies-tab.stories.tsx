import { useEffect, useMemo, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolCatalogEntry, ToolConnection, ToolPolicy } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { PoliciesTab } from "@/pages/tools/PoliciesTab";

const COMPANY = "company-storybook";

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
    name: toolName,
    toolName,
    title,
    description: title,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    riskLevel: cap,
    isReadOnly: cap === "read",
    isWrite: cap !== "read",
    isDestructive: cap === "destructive",
    status: "active",
    addedAt: new Date("2026-06-01T00:00:00Z"),
    version: null,
    versionHash: null,
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

const GMAIL: ToolCatalogEntry[] = [
  makeTool("g-list", "gmail.list_messages", "read", "List messages", "app-gmail", "conn-gmail"),
  makeTool("g-read", "gmail.get_message", "read", "Read a message", "app-gmail", "conn-gmail"),
  makeTool("g-send", "gmail.send_message", "write", "Send a message", "app-gmail", "conn-gmail"),
  makeTool("g-draft", "gmail.create_draft", "write", "Create a draft", "app-gmail", "conn-gmail"),
  makeTool("g-trash", "gmail.trash_message", "destructive", "Move to trash", "app-gmail", "conn-gmail"),
  makeTool("g-delete", "gmail.delete_message", "destructive", "Permanently delete", "app-gmail", "conn-gmail"),
];

const SLACK: ToolCatalogEntry[] = [
  makeTool("s-list", "slack.list_channels", "read", "List channels", "app-slack", "conn-slack"),
  makeTool("s-post", "slack.post_message", "write", "Post a message", "app-slack", "conn-slack"),
  makeTool("s-archive", "slack.archive_channel", "destructive", "Archive a channel", "app-slack", "conn-slack"),
];

const CATALOG: ToolCatalogEntry[] = [...GMAIL, ...SLACK];

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
  { id: "agent-fable", name: "Fable" },
  { id: "agent-sage", name: "Sage" },
  { id: "agent-atlas", name: "Atlas" },
];

const PROJECTS = [
  { id: "project-launch", name: "Launch" },
  { id: "project-support", name: "Support" },
];

function rule(partial: Partial<ToolPolicy> & { id: string; policyType: ToolPolicy["policyType"]; priority: number }): ToolPolicy {
  return {
    id: partial.id,
    companyId: COMPANY,
    name: partial.name ?? partial.id,
    description: partial.description ?? null,
    policyType: partial.policyType,
    priority: partial.priority,
    enabled: partial.enabled ?? true,
    selectors: partial.selectors ?? {},
    conditions: partial.conditions ?? null,
    config: partial.config ?? null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-11T00:00:00Z"),
  };
}

const POLICIES: ToolPolicy[] = [
  rule({
    id: "p1",
    name: "Block destructive actions everywhere",
    policyType: "block",
    priority: 50,
    selectors: { riskLevel: "destructive" },
  }),
  rule({
    id: "p2",
    name: "Ask first when Fable sends mail",
    policyType: "require_approval",
    priority: 100,
    selectors: { agentId: "agent-fable", toolName: "gmail.send_message" },
  }),
  rule({
    id: "p3",
    name: "Limit Slack posts",
    policyType: "rate_limit",
    priority: 150,
    selectors: { toolName: "slack.post_message" },
    config: { rateLimit: { limit: 25, windowSeconds: 3600, keyBy: ["agent", "tool"] } },
  }),
  rule({
    id: "p4",
    name: "Allow Sage to use Gmail",
    policyType: "allow",
    priority: 200,
    selectors: { agentId: "agent-sage", applicationId: "app-gmail" },
  }),
  rule({
    id: "p5",
    name: "Block critical actions",
    policyType: "block",
    priority: 300,
    selectors: { riskLevel: "critical" },
  }),
];

const TRUST_RULES: ToolPolicy[] = [
  rule({
    id: "trust-1",
    policyType: "trust_rule",
    priority: 1000,
    selectors: { agentId: "agent-fable", toolName: "gmail.send_message" },
  }),
  rule({
    id: "trust-2",
    policyType: "trust_rule",
    priority: 1000,
    selectors: { agentId: "agent-sage", toolName: "slack.post_message" },
  }),
];

const AUDIT_HITS = [
  { policyId: "p1", count: 14 },
  { policyId: "p2", count: 6 },
  { policyId: "p3", count: 22 },
  { policyId: "p4", count: 3 },
  { policyId: "p5", count: 1 },
];

function buildAudit() {
  const now = Date.now();
  const rows: Array<{ createdAt: string; details: { matchedPolicyIds: string[] } }> = [];
  for (const hit of AUDIT_HITS) {
    for (let i = 0; i < hit.count; i += 1) {
      rows.push({
        createdAt: new Date(now - i * 60_000).toISOString(),
        details: { matchedPolicyIds: [hit.policyId] },
      });
    }
  }
  return rows;
}

function seededClient({
  policies,
  trustRules,
}: {
  policies: ToolPolicy[];
  trustRules: ToolPolicy[];
}) {
  const c = new QueryClient({
    defaultOptions: {
      queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false },
    },
  });
  c.setQueryData(queryKeys.tools.policies(COMPANY), { policies });
  c.setQueryData(queryKeys.tools.trustRules(COMPANY), { trustRules });
  c.setQueryData(queryKeys.tools.audit(COMPANY, 250), buildAudit());
  c.setQueryData(queryKeys.agents.list(COMPANY), AGENTS);
  c.setQueryData(queryKeys.projects.list(COMPANY), PROJECTS);
  c.setQueryData(queryKeys.tools.applications(COMPANY), {
    applications: [
      { id: "app-gmail", name: "Gmail" },
      { id: "app-slack", name: "Slack" },
    ],
  });
  c.setQueryData(queryKeys.tools.connections(COMPANY), { connections: CONNECTIONS });
  c.setQueryData(queryKeys.tools.catalog("conn-gmail"), { catalog: GMAIL });
  c.setQueryData(queryKeys.tools.catalog("conn-slack"), { catalog: SLACK });
  return c;
}

function findButtonByText(label: string): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button"));
  return buttons.find((b) => (b.textContent ?? "").trim() === label) ?? null;
}

function PoliciesHost({
  policies = POLICIES,
  trustRules = TRUST_RULES,
  autoClick,
}: {
  policies?: ToolPolicy[];
  trustRules?: ToolPolicy[];
  autoClick?: "new-rule" | "test-rule";
}) {
  const client = useMemo(() => seededClient({ policies, trustRules }), [policies, trustRules]);
  const triggered = useRef(false);
  useEffect(() => {
    if (!autoClick || triggered.current) return;
    let cancelled = false;
    const tryClick = (attempt: number) => {
      if (cancelled || triggered.current) return;
      const label = autoClick === "new-rule" ? "New rule" : "Test a rule";
      const button = findButtonByText(label);
      if (button) {
        triggered.current = true;
        button.click();
        return;
      }
      if (attempt < 30) window.setTimeout(() => tryClick(attempt + 1), 50);
    };
    tryClick(0);
    return () => {
      cancelled = true;
    };
  }, [autoClick]);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-6xl p-6">
        <PoliciesTab companyId={COMPANY} />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Tools/Rules (PAP-11049)",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const IndexPopulated: Story = {
  name: "Rules index — populated",
  render: () => <PoliciesHost />,
};

export const Empty: Story = {
  name: "Rules — empty state",
  render: () => <PoliciesHost policies={[]} trustRules={[]} />,
};

export const BuilderNewRule: Story = {
  name: "Rule builder — after New rule",
  render: () => <PoliciesHost autoClick="new-rule" />,
};

export const TestRuleSlideover: Story = {
  name: "Test a rule — slide-over",
  render: () => <PoliciesHost autoClick="test-rule" />,
};
