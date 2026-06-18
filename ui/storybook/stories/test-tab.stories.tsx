import { useEffect, useMemo, useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ToolCatalogEntry,
  ToolConnectionTestAgent,
  ToolConnectionTestCallResult,
  ToolConnectionTestDecision,
} from "@paperclipai/shared";
import { queryKeys } from "@/lib/queryKeys";
import { TestPanel } from "@/pages/apps/app-detail/TestPanel";

const CONNECTION = "conn-sheets";

// ---------------------------------------------------------------------------
// Catalog (12 actions: 7 read, 5 write) — mirrors the PAP-11348 wireframes.
// ---------------------------------------------------------------------------

function tool(
  id: string,
  toolName: string,
  title: string,
  description: string,
  read: boolean,
  inputSchema: Record<string, unknown> | null = null,
): ToolCatalogEntry {
  return {
    id,
    companyId: "company-storybook",
    applicationId: "app-sheets",
    connectionId: CONNECTION,
    entryKind: "tool",
    name: toolName,
    toolName,
    title,
    description,
    inputSchema,
    outputSchema: null,
    annotations: null,
    riskLevel: read ? "read" : "write",
    isReadOnly: read,
    isWrite: !read,
    isDestructive: false,
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

const READ_SHEET_SCHEMA = {
  type: "object",
  properties: {
    spreadsheetId: { type: "string", title: "Spreadsheet" },
    sheet: { type: "string", title: "Sheet" },
    range: { type: "string", title: "Range", description: "e.g. A1:F50" },
  },
  required: ["spreadsheetId", "sheet"],
};

const APPEND_ROW_SCHEMA = {
  type: "object",
  properties: {
    spreadsheetId: { type: "string", title: "Spreadsheet" },
    sheet: { type: "string", title: "Sheet" },
    values: { type: "string", title: "Values", description: "Comma-separated cell values" },
  },
  required: ["spreadsheetId", "sheet", "values"],
};

const DELETE_ROW_SCHEMA = {
  type: "object",
  properties: {
    spreadsheetId: { type: "string", title: "Spreadsheet" },
    rowNumber: { type: "number", title: "Row number" },
  },
  required: ["spreadsheetId", "rowNumber"],
};

const CATALOG: ToolCatalogEntry[] = [
  tool("r1", "list_spreadsheets", "List spreadsheets", "See the spreadsheets in this account.", true),
  tool("r2", "read_sheet", "Read a sheet", "Get rows and cell values from a sheet.", true, READ_SHEET_SCHEMA),
  tool("r3", "search_rows", "Search rows", "Find rows that match a query.", true),
  tool("r4", "get_cell", "Get a cell", "Read a single cell value.", true),
  tool("r5", "list_sheets", "List sheets", "See the tabs in a spreadsheet.", true),
  tool("r6", "get_metadata", "Get spreadsheet info", "Read a spreadsheet's title and tabs.", true),
  tool("r7", "describe_columns", "Describe columns", "List the column headers in a sheet.", true),
  tool("w1", "append_row", "Append a row", "Add a new row to the bottom of a sheet.", false, APPEND_ROW_SCHEMA),
  tool("w2", "update_cell", "Update a cell", "Change a single cell value.", false),
  tool("w3", "create_sheet", "Add a sheet", "Create a new tab in a spreadsheet.", false),
  tool("w4", "clear_range", "Clear a range", "Empty the cells in a range.", false),
  tool("w5", "delete_row", "Delete a row", "Remove a row from a sheet permanently.", false, DELETE_ROW_SCHEMA),
];

function decisionTool(entry: ToolCatalogEntry, decision: ToolConnectionTestDecision) {
  return {
    toolName: entry.toolName,
    gatewayToolName: `sheets__${entry.toolName}`,
    displayName: entry.title,
    risk: (entry.isReadOnly ? "read" : "write") as "read" | "write" | "destructive",
    decision,
    reasonCode: null,
    matchedPolicyIds: [],
  };
}

// Decisions: 9 allowed (7 read + 2 write), 2 ask first, 1 off.
const DECISIONS: Record<string, ToolConnectionTestDecision> = {
  list_spreadsheets: "allowed",
  read_sheet: "allowed",
  search_rows: "allowed",
  get_cell: "allowed",
  list_sheets: "allowed",
  get_metadata: "allowed",
  describe_columns: "allowed",
  append_row: "ask_first",
  update_cell: "allowed",
  create_sheet: "allowed",
  clear_range: "ask_first",
  delete_row: "off",
};

function buildAgent(id: string, name: string, decisions: Record<string, ToolConnectionTestDecision>): ToolConnectionTestAgent {
  const tools = CATALOG.map((entry) => decisionTool(entry, decisions[entry.toolName]));
  return {
    id,
    name,
    role: "engineer",
    title: "Engineer",
    status: "active",
    effectiveAccess: {
      connectionId: CONNECTION,
      toolCount: tools.length,
      allowedCount: tools.filter((t) => t.decision === "allowed").length,
      askFirstCount: tools.filter((t) => t.decision === "ask_first").length,
      offCount: tools.filter((t) => t.decision === "off").length,
      tools,
    },
  };
}

const AGENTS: ToolConnectionTestAgent[] = [
  buildAgent("agent-claude", "ClaudeCoder", DECISIONS),
  buildAgent("agent-codex", "CodexCoder", {
    ...DECISIONS,
    create_sheet: "ask_first",
    clear_range: "off",
  }),
];

// ---------------------------------------------------------------------------
// DOM driver — expand a row, fill its fields, press Run.
// ---------------------------------------------------------------------------

type Step =
  | { kind: "expand"; title: string }
  | { kind: "fill"; values: string[] }
  | { kind: "click"; label: string };

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function runScript(steps: Step[]) {
  let index = 0;
  const tick = (attempt: number) => {
    if (index >= steps.length) return;
    const step = steps[index];
    if (step.kind === "expand") {
      const btn = Array.from(document.querySelectorAll("button")).find((b) =>
        b.textContent?.includes(step.title),
      );
      if (btn) {
        btn.click();
        index += 1;
        window.setTimeout(() => tick(0), 60);
        return;
      }
    } else if (step.kind === "fill") {
      const inputs = Array.from(document.querySelectorAll("input")).filter(
        (i) => i.getAttribute("aria-label") !== "Find an action" && i.getAttribute("aria-label") !== "Search agents",
      );
      if (inputs.length >= step.values.length) {
        step.values.forEach((value, i) => setInputValue(inputs[i] as HTMLInputElement, value));
        index += 1;
        window.setTimeout(() => tick(0), 60);
        return;
      }
    } else if (step.kind === "click") {
      const btn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === step.label,
      );
      if (btn) {
        btn.click();
        index += 1;
        window.setTimeout(() => tick(0), 60);
        return;
      }
    }
    if (attempt < 40) window.setTimeout(() => tick(attempt + 1), 50);
  };
  tick(0);
}

function seededClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false, refetchOnMount: false } },
  });
  client.setQueryData(queryKeys.tools.testAgents(CONNECTION), { agents: AGENTS });
  return client;
}

function TestHost({
  script,
  runResult,
  runDelayMs = 120,
}: {
  script?: Step[];
  runResult?: ToolConnectionTestCallResult;
  runDelayMs?: number;
}) {
  const client = useMemo(() => seededClient(), []);
  const fetchPatched = useRef(false);

  // Stub the test-call POST so the run states render without a backend.
  useEffect(() => {
    if (fetchPatched.current) return;
    fetchPatched.current = true;
    const original = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/test-calls")) {
        await new Promise((resolve) => window.setTimeout(resolve, runDelayMs));
        return Response.json(runResult ?? { decision: "allowed", invocationId: "inv-storybook", result: {} });
      }
      return original(input, init);
    };
    return () => {
      window.fetch = original;
    };
  }, [runResult, runDelayMs]);

  useEffect(() => {
    if (!script) return;
    const timer = window.setTimeout(() => runScript(script), 150);
    return () => window.clearTimeout(timer);
  }, [script]);

  return (
    <QueryClientProvider client={client}>
      <div className="mx-auto max-w-3xl p-6">
        <TestPanel connectionId={CONNECTION} appName="Google Sheets" active={CATALOG} />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta = {
  title: "Apps/Test tab (PAP-11350)",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

export const Default: Story = {
  name: "Default — grouped actions + access badges",
  render: () => <TestHost />,
};

export const AllowedResult: Story = {
  name: "Allowed — result panel",
  render: () => (
    <TestHost
      runResult={{
        decision: "allowed",
        invocationId: "inv-allowed",
        result: [
          { Name: "Acme Co.", Stage: "Demo", Owner: "Dotta", Updated: "Tue" },
          { Name: "Globex", Stage: "Trial", Owner: "Dotta", Updated: "Mon" },
          { Name: "Initech", Stage: "Closed", Owner: "CodexCoder", Updated: "Sun" },
          { Name: "Soylent", Stage: "Discovery", Owner: "QA", Updated: "Fri" },
          { Name: "Umbrella", Stage: "Trial", Owner: "Dotta", Updated: "Thu" },
        ],
      }}
      script={[
        { kind: "expand", title: "Read a sheet" },
        { kind: "fill", values: ["Q3 Pipeline Tracker", "Leads"] },
        { kind: "click", label: "Run" },
      ]}
    />
  ),
};

export const AskFirstResult: Story = {
  name: "Ask first — sent for approval",
  render: () => (
    <TestHost
      runResult={{ decision: "ask_first", invocationId: "inv-ask", actionRequestId: "req-1" }}
      script={[
        { kind: "expand", title: "Append a row" },
        { kind: "fill", values: ["Q3 Pipeline Tracker", "Leads", "Wayne Industries, Demo, Dotta"] },
        { kind: "click", label: "Run" },
      ]}
    />
  ),
};

export const ErrorResult: Story = {
  name: "Error — what the app said + what to try",
  render: () => (
    <TestHost
      runResult={{
        decision: "allowed",
        invocationId: "inv-error",
        error: { message: "Requested entity was not found.", reasonCode: "NOT_FOUND" },
      }}
      script={[
        { kind: "expand", title: "Read a sheet" },
        { kind: "fill", values: ["1AbCxyz…NotFound", "Leads"] },
        { kind: "click", label: "Run" },
      ]}
    />
  ),
};

export const RunningState: Story = {
  name: "Running — in-flight card",
  render: () => (
    <TestHost
      runDelayMs={20000}
      script={[
        { kind: "expand", title: "Read a sheet" },
        { kind: "fill", values: ["Q3 Pipeline Tracker", "Leads"] },
        { kind: "click", label: "Run" },
      ]}
    />
  ),
};

export const OffAction: Story = {
  name: "Off — explanation + open Permissions",
  render: () => <TestHost script={[{ kind: "expand", title: "Delete a row" }]} />,
};
