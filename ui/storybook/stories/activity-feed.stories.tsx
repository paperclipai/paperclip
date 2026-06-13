import { useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import type { ToolGatewayActivityEvent } from "@/api/tools";
import { AuditTab } from "@/pages/tools/AuditTab";

const COMPANY = "company-storybook";
const MIN = 60 * 1000;

function event(overrides: Partial<ToolGatewayActivityEvent> = {}): ToolGatewayActivityEvent {
  return {
    id: "evt-1",
    companyId: COMPANY,
    action: "tool_gateway.call_completed",
    actorType: "agent",
    actorId: "agent-fable",
    entityType: "issue",
    entityId: "run-1",
    agentId: "agent-fable",
    runId: "11111111-1111-4111-8111-111111111111",
    applicationId: "app-gmail",
    connectionId: "conn-gmail",
    agentDisplayName: "Fable",
    appDisplayName: "Gmail",
    applicationDisplayName: "Gmail",
    connectionDisplayName: "Gmail",
    toolDisplayName: "Send Email",
    normalizedOutcome: "allowed",
    details: {
      reasonCode: "profile_allows_tool",
      tool: "mail:send_email",
      issueId: "issue-1",
      runId: "11111111-1111-4111-8111-111111111111",
      matchedPolicyIds: ["pol-allow-mail"],
    },
    createdAt: new Date(Date.now() - 5 * MIN).toISOString(),
    ...overrides,
  };
}

const EVENTS: ToolGatewayActivityEvent[] = [
  event(),
  event({
    id: "evt-2",
    action: "tool_gateway.call_denied",
    agentDisplayName: "Scout",
    actorId: "agent-scout",
    agentId: "agent-scout",
    toolDisplayName: "Delete Spreadsheet",
    appDisplayName: "Google Sheets",
    applicationDisplayName: "Google Sheets",
    connectionDisplayName: "Google Sheets",
    normalizedOutcome: "blocked",
    details: {
      reasonCode: "deny_policy_block",
      tool: "sheets:delete_spreadsheet",
      issueId: "issue-2",
      runId: "22222222-2222-4222-8222-222222222222",
      matchedPolicyIds: ["pol-block-destructive"],
    },
    createdAt: new Date(Date.now() - 12 * MIN).toISOString(),
  }),
  event({
    id: "evt-3",
    action: "tool_gateway.approval_requested",
    agentDisplayName: "Fable",
    toolDisplayName: "Send Money",
    appDisplayName: "Mercury",
    applicationDisplayName: "Mercury",
    connectionDisplayName: "Mercury",
    normalizedOutcome: "asked_first",
    details: { reasonCode: "requires_approval_policy", tool: "mercury:send_money", issueId: "issue-3" },
    createdAt: new Date(Date.now() - 26 * MIN).toISOString(),
  }),
  event({
    id: "evt-4",
    action: "tool_gateway.call_failed",
    agentDisplayName: "Scout",
    toolDisplayName: "Create Issue",
    appDisplayName: "GitHub",
    applicationDisplayName: "GitHub",
    connectionDisplayName: "GitHub",
    normalizedOutcome: "failed",
    details: { reasonCode: "tool_failed", tool: "github:create_issue", issueId: "issue-4" },
    createdAt: new Date(Date.now() - 48 * MIN).toISOString(),
  }),
  event({
    id: "evt-5",
    action: "tool_gateway.call_deferred",
    agentDisplayName: "Fable",
    toolDisplayName: "Read Channel",
    appDisplayName: "Slack",
    applicationDisplayName: "Slack",
    connectionDisplayName: "Slack",
    normalizedOutcome: "waiting",
    details: { reasonCode: "defer_runtime", tool: "slack:read_channel" },
    createdAt: new Date(Date.now() - 70 * MIN).toISOString(),
  }),
];

const APPLICATIONS = [
  { id: "app-gmail", name: "Gmail" },
  { id: "app-sheets", name: "Google Sheets" },
  { id: "app-mercury", name: "Mercury" },
  { id: "app-github", name: "GitHub" },
  { id: "app-slack", name: "Slack" },
];

const AGENTS = [
  { id: "agent-fable", name: "Fable" },
  { id: "agent-scout", name: "Scout" },
];

const POLICIES = [
  { id: "pol-allow-mail", name: "Fable can email customers" },
  { id: "pol-block-destructive", name: "destructive actions → Block" },
];

function defaultActivityKey() {
  return queryKeys.tools.activity(COMPANY, { window: "24h" });
}

function Seeded({ events }: { events: ToolGatewayActivityEvent[] }) {
  const client = useMemo(() => {
    const c = new QueryClient({
      defaultOptions: {
        queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false },
      },
    });
    c.setQueryData(defaultActivityKey(), {
      pages: [{ events, nextCursor: null }],
      pageParams: [null],
    });
    // Filtered-empty: typing "refund" resolves to an empty page.
    c.setQueryData(queryKeys.tools.activity(COMPANY, { window: "24h", search: "refund" }), {
      pages: [{ events: [], nextCursor: null }],
      pageParams: [null],
    });
    c.setQueryData(queryKeys.tools.applications(COMPANY), { applications: APPLICATIONS });
    c.setQueryData(queryKeys.agents.list(COMPANY), AGENTS);
    c.setQueryData(queryKeys.tools.policies(COMPANY), { policies: POLICIES });
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-5xl p-6">
        <AuditTab companyId={COMPANY} />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Tools/Activity (audit feed)",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const Populated: Story = {
  name: "Populated",
  render: () => <Seeded events={EVENTS} />,
};

export const RowExpanded: Story = {
  name: "Row expanded (use the chevron)",
  render: () => <Seeded events={EVENTS} />,
};

export const TrueEmpty: Story = {
  name: "Empty",
  render: () => <Seeded events={[]} />,
};

export const FilteredEmpty: Story = {
  name: "Filtered empty (type 'refund' in search)",
  render: () => <Seeded events={EVENTS} />,
};
