import { useEffect, useMemo } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolCatalogEntry, ToolConnectionTestCallResult } from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { ActionsSection } from "@/pages/apps/app-detail/PermissionsPanel";

const CONNECTION = "conn-asana-storybook";
const TOOL: ToolCatalogEntry = {
  id: "asana-list-projects",
  companyId: "company-storybook",
  applicationId: "app-asana",
  connectionId: CONNECTION,
  entryKind: "tool",
  toolName: "list_projects",
  title: "List projects",
  description: "Find projects available in this Asana workspace.",
  inputSchema: { type: "object", properties: {} },
  outputSchema: null,
  annotations: null,
  riskLevel: "read",
  isReadOnly: true,
  isWrite: false,
  isDestructive: false,
  status: "active",
  addedAt: new Date("2026-09-01T00:00:00Z"),
  version: null,
  schemaHash: null,
  firstSeenAt: new Date("2026-09-01T00:00:00Z"),
  lastSeenAt: new Date("2026-10-01T00:00:00Z"),
  reviewedAt: null,
  reviewedByAgentId: null,
  reviewedByUserId: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
} as ToolCatalogEntry;

const PROJECTS = [
  { gid: "1214644669600482", name: "Q4 launch", resource_subtype: "default_project", team: "Marketing" },
  { gid: "1214644669600483", name: "Customer onboarding", resource_subtype: "default_project", team: "Product" },
  { gid: "1214644669600484", name: "Support operations", resource_subtype: "default_project", team: "Operations" },
];

const NOTION_TOOL = {
  ...TOOL,
  id: "notion-search",
  applicationId: "app-notion",
  toolName: "search",
  title: "Search Notion",
  description: "Search pages in your Notion workspace.",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
} as ToolCatalogEntry;

const NOTION_RESULTS = [
  {
    id: "11111111-2222-4333-8444-555555555555",
    title: "Northstar launch plan",
    url: "https://www.notion.so/11111111222243338444555555555555",
    type: "page",
    highlight: "The team is tracking launch milestones, owners, dependencies, and the decisions needed before the release window.",
    timestamp: "2026-09-10T14:30:00.000Z",
  },
  {
    id: "66666666-7777-4888-8999-aaaaaaaaaaaa",
    title: "Launch customer research",
    url: "https://www.notion.so/66666666777748888999aaaaaaaaaaaa",
    type: "page",
    highlight: "Interviews with early customers point to a clearer onboarding flow and better examples for complex team setups.",
    timestamp: "2026-09-08T09:15:00.000Z",
  },
];

function mcpResult(content: Array<Record<string, unknown>>, structuredContent: unknown = null, isError = false) {
  return {
    content: content.map((block) => block.type === "text" ? block.text : JSON.stringify(block)).join("\n"),
    data: { content, structuredContent, isError, transport: "mcp_http", spawnedLocalProcess: false },
    ...(isError ? { error: "MCP tool returned an error result" } : {}),
  };
}

function seededClient(tool: ToolCatalogEntry) {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
  });
  client.setQueryData(queryKeys.tools.testAgents(CONNECTION), {
    agents: [{ id: "agent-ceo", name: "CEO", role: "ceo", title: "CEO", status: "active", orgDepth: 0 }],
  });
  client.setQueryData(queryKeys.tools.testAgentAccess(CONNECTION, "agent-ceo"), {
    access: {
      connectionId: CONNECTION,
      toolCount: 1,
      allowedCount: 1,
      askFirstCount: 0,
      offCount: 0,
      lastChangedAt: null,
      lastChangedByAgentId: null,
      lastChangedByName: null,
      tools: [{
        toolName: tool.toolName,
        gatewayToolName: `${tool.applicationId}__${tool.toolName}`,
        displayName: tool.title,
        risk: "read",
        decision: "allowed",
        reasonCode: null,
        matchedPolicyIds: [],
      }],
    },
  });
  return client;
}

function openAndRun(query?: string) {
  let step = 0;
  const tick = (attempt: number) => {
    if (step === 0) {
      const button = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === "Test");
      if (button) { button.click(); step = 1; }
    } else {
      const dialog = document.querySelector('[role="dialog"]');
      if (query && step === 1) {
        const input = dialog?.querySelector('input[placeholder=""]') as HTMLInputElement | null;
        if (input) {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, query);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          step = 2;
        }
      }
      const run = [...(dialog?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.trim() === "Run");
      if (run && (!query || step === 2)) { run.click(); return; }
    }
    if (attempt < 80) window.setTimeout(() => tick(attempt + 1), 50);
  };
  tick(0);
}

function PermissionsTestStory({ result, tool = TOOL, appName = "Asana", query }: {
  result: ToolConnectionTestCallResult;
  tool?: ToolCatalogEntry;
  appName?: string;
  query?: string;
}) {
  const client = useMemo(() => seededClient(tool), [tool]);
  useEffect(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes(`/tool-connections/${CONNECTION}/test-calls`)) {
        await new Promise((resolve) => window.setTimeout(resolve, 120));
        return Response.json(result);
      }
      return original(input, init);
    };
    const timer = window.setTimeout(() => openAndRun(query), 150);
    return () => { window.clearTimeout(timer); window.fetch = original; };
  }, [query, result]);
  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-3xl p-6">
        <ActionsSection
          connectionId={CONNECTION}
          appName={appName}
          readOnly={[tool]}
          canChange={[]}
          quarantined={[]}
          enabledIds={new Set([tool.id])}
          askFirstIds={new Set()}
          disabled={false}
          refreshPending={false}
          canConfigure
          onSetPermission={() => undefined}
          onReviewQuarantined={() => undefined}
          onRefreshActions={() => undefined}
        />
      </div>
    </QueryClientProvider>
  );
}

const meta = {
  title: "Apps/Action permissions test",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const StructuredRows: Story = {
  name: "Structured rows",
  render: () => <PermissionsTestStory result={{ decision: "allowed", invocationId: "structured", result: mcpResult(
    [{ type: "text", text: JSON.stringify({ data: PROJECTS }) }],
    { data: PROJECTS },
  ) }} />,
};

export const JsonInText: Story = {
  name: "JSON inside text",
  render: () => <PermissionsTestStory result={{ decision: "allowed", invocationId: "json-text", result: mcpResult(
    [{ type: "text", text: JSON.stringify({ data: PROJECTS }) }],
  ) }} />,
};

export const NotionWideSearch: Story = {
  name: "Notion search with long fields",
  render: () => <PermissionsTestStory tool={NOTION_TOOL} appName="Notion" query="launch" result={{
    decision: "allowed", invocationId: "notion-search", result: mcpResult(
      [{ type: "text", text: JSON.stringify({ results: NOTION_RESULTS }) }],
    ),
  }} />,
};

export const MixedBlocks: Story = {
  name: "Mixed content blocks",
  render: () => <PermissionsTestStory result={{ decision: "allowed", invocationId: "mixed", result: mcpResult(
    [
      { type: "text", text: "Three active projects are visible in this workspace." },
      { type: "resource_link", uri: "asana://projects/q4-launch", name: "Q4 launch" },
      { type: "image", mimeType: "image/png", data: "cHJldmlldw==" },
    ],
    { data: PROJECTS },
  ) }} />,
};

export const ToolError: Story = {
  name: "Tool error with raw response",
  render: () => <PermissionsTestStory result={{ decision: "allowed", invocationId: "error", result: mcpResult(
    [{ type: "text", text: "Asana denied access to this workspace." }], null, true,
  ) }} />,
};

export const MalformedBlock: Story = {
  name: "Unexpected block with raw fallback",
  render: () => <PermissionsTestStory result={{ decision: "allowed", invocationId: "malformed", result: mcpResult(
    [{ type: "text", payload: "Missing the required text field" }],
  ) }} />,
};
