// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCatalogEntry } from "@paperclipai/shared";
import { ActionTestDialog, errorHints } from "./ActionTestDialog";

const listTestAgentsMock = vi.hoisted(() => vi.fn());
const getTestAgentAccessMock = vi.hoisted(() => vi.fn());
const runTestCallMock = vi.hoisted(() => vi.fn());
const getTestCallStatusMock = vi.hoisted(() => vi.fn());
const declineActionRequestMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listTestAgents: (connectionId: string) => listTestAgentsMock(connectionId),
    getTestAgentAccess: (connectionId: string, agentId: string) => getTestAgentAccessMock(connectionId, agentId),
    runTestCall: (connectionId: string, input: unknown) => runTestCallMock(connectionId, input),
    getTestCallStatus: (connectionId: string, requestId: string) => getTestCallStatusMock(connectionId, requestId),
    declineActionRequest: (companyId: string, requestId: string) => declineActionRequestMock(companyId, requestId),
  },
}));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const entry = {
  id: "asana-list-projects",
  companyId: "company-1",
  applicationId: "app-asana",
  connectionId: "conn-1",
  entryKind: "tool",
  toolName: "list_projects",
  title: "List projects",
  description: "Find Asana projects.",
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

const askFirstEntry = {
  ...entry,
  id: "asana-create-task",
  toolName: "create_task",
  title: "Create task",
  riskLevel: "write",
  isReadOnly: false,
  isWrite: true,
} as ToolCatalogEntry;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let client: QueryClient;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => { result = callback(); });
  await result;
}

async function flushReact() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function renderDialog(testEntry = entry) {
  await act(() => root.render(
    <QueryClientProvider client={client}>
      <ActionTestDialog connectionId="conn-1" appName="Asana" entry={testEntry} open onOpenChange={() => undefined} />
    </QueryClientProvider>,
  ));
  await flushReact();
}

async function openAndRun(testEntry = entry) {
  await renderDialog(testEntry);
  const button = [...document.body.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === "Run");
  expect(button).toBeTruthy();
  await act(() => button!.click());
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 260)); });
  await flushReact();
}

function allowAskFirst() {
  getTestAgentAccessMock.mockResolvedValue({
    access: {
      connectionId: "conn-1", toolCount: 1, allowedCount: 0, askFirstCount: 1, offCount: 0,
      lastChangedAt: null, lastChangedByAgentId: null, lastChangedByName: null,
      tools: [{ toolName: "create_task", gatewayToolName: "asana__create_task", displayName: "Create task", risk: "write", decision: "ask_first", reasonCode: null, matchedPolicyIds: [] }],
    },
  });
  runTestCallMock.mockResolvedValue({ decision: "ask_first", invocationId: "ask-invocation", actionRequestId: "request-1" });
}

function requestStatus(phase: "waiting" | "running" | "done" | "denied") {
  return {
    actionRequestId: "request-1", invocationId: "ask-invocation", phase,
    parameters: {}, requestedAt: "2026-10-01T00:00:00.000Z",
    resolvedAt: phase === "waiting" ? null : "2026-10-01T00:00:05.000Z",
    durationMs: phase === "done" ? 1200 : null,
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  listTestAgentsMock.mockReset().mockResolvedValue({
    agents: [{ id: "agent-ceo", name: "CEO", role: "ceo", title: "CEO", status: "active", orgDepth: 0 }],
  });
  getTestAgentAccessMock.mockReset().mockResolvedValue({
    access: {
      connectionId: "conn-1", toolCount: 1, allowedCount: 1, askFirstCount: 0, offCount: 0,
      lastChangedAt: null, lastChangedByAgentId: null, lastChangedByName: null,
      tools: [{ toolName: "list_projects", gatewayToolName: "asana__list_projects", displayName: "List projects", risk: "read", decision: "allowed", reasonCode: null, matchedPolicyIds: [] }],
    },
  });
  runTestCallMock.mockReset();
  getTestCallStatusMock.mockReset().mockResolvedValue(requestStatus("waiting"));
  declineActionRequestMock.mockReset();
  window.sessionStorage.clear();
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  window.sessionStorage.clear();
});

describe("Permissions action Test dialog", () => {
  it("renders structured MCP rows and keeps the full response behind the raw disclosure", async () => {
    runTestCallMock.mockResolvedValue({
      decision: "allowed", invocationId: "structured",
      result: {
        content: '{"data":[{"name":"Q4 launch"},{"name":"Customer onboarding"}]}',
        data: {
          content: [{ type: "text", text: '{"data":[{"name":"Q4 launch"},{"name":"Customer onboarding"}]}' }],
          structuredContent: { data: [{ name: "Q4 launch" }, { name: "Customer onboarding" }] },
          isError: false, transport: "mcp_http",
        },
      },
    });
    await openAndRun();
    expect(runTestCallMock).toHaveBeenCalledWith("conn-1", { agentId: "agent-ceo", toolName: "list_projects", parameters: {} });
    expect(document.body.textContent).toContain("Worked. 2 rows came back.");
    expect(document.body.querySelector("table")?.textContent).toContain("Q4 launch");
    expect(document.body.textContent).not.toContain("structuredContent");
    const raw = [...document.body.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Show raw response");
    await act(() => raw!.click());
    expect(document.body.textContent).toContain("structuredContent");
  });

  it("parses JSON text when structured content is absent", async () => {
    runTestCallMock.mockResolvedValue({
      decision: "allowed", invocationId: "text",
      result: { content: '{"data":[{"name":"Q4 launch"}]}', data: { content: [{ type: "text", text: '{"data":[{"name":"Q4 launch"}]}' }], structuredContent: null, isError: false } },
    });
    await openAndRun();
    expect(document.body.querySelector("table")?.textContent).toContain("Q4 launch");
  });

  it("uses structured content when an MCP result has no content blocks", async () => {
    runTestCallMock.mockResolvedValue({
      decision: "allowed", invocationId: "structured-only",
      result: { content: "", data: { structuredContent: { results: [{ name: "Northstar launch plan" }] }, isError: false } },
    });
    await openAndRun();
    expect(document.body.textContent).toContain("Worked. 1 row came back.");
    expect(document.body.querySelector("table")?.textContent).toContain("Northstar launch plan");
    expect(document.body.textContent).not.toContain("structuredContent");
  });

  it("shows wide search results as readable cards with a safe page link", async () => {
    const rows = [{
      id: "11111111-2222-4333-8444-555555555555",
      title: "Northstar launch plan",
      url: "https://www.notion.so/11111111222243338444555555555555",
      type: "page",
      highlight: "The launch plan covers milestones, owners, and a detailed summary that should not stretch a table row in the dialog.",
      timestamp: "2026-09-10T14:30:00.000Z",
    }];
    runTestCallMock.mockResolvedValue({
      decision: "allowed", invocationId: "notion-wide",
      result: { content: JSON.stringify({ results: rows }), data: { content: [{ type: "text", text: JSON.stringify({ results: rows }) }], structuredContent: null, isError: false } },
    });
    await openAndRun();
    expect(document.body.querySelector("table")).toBeNull();
    expect(document.body.textContent).toContain("Northstar launch plan");
    expect(document.body.textContent).toContain("The launch plan covers milestones");
    expect(document.body.querySelector('a[href="https://www.notion.so/11111111222243338444555555555555"]')?.textContent).toBe("Open link");
  });

  it("shows a non-link URL as a field in a result card", async () => {
    const rows = [{ title: "Northstar launch plan", url: "notion://workspace/launch", description: "A long description that keeps the card layout useful even when the provider supplies a URL that cannot open in a browser." }];
    runTestCallMock.mockResolvedValue({
      decision: "allowed", invocationId: "non-link-url",
      result: { content: JSON.stringify({ results: rows }), data: { content: [{ type: "text", text: JSON.stringify({ results: rows }) }], isError: false } },
    });
    await openAndRun();
    expect(document.body.querySelector('a[href="notion://workspace/launch"]')).toBeNull();
    expect(document.body.textContent).toContain("notion://workspace/launch");
  });

  it("keeps an ask-first request visible after reopening the dialog", async () => {
    allowAskFirst();
    await openAndRun(askFirstEntry);
    expect(document.body.textContent).toContain("Sent for your OK.");
    expect(document.body.textContent).toContain("Cancel this request");
    expect(document.body.querySelector('a[href="/apps/conn-1/review"]')).toBeTruthy();

    await act(() => root.unmount());
    root = createRoot(container);
    await renderDialog(askFirstEntry);
    expect(runTestCallMock).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Sent for your OK.");
  });

  it("shows an approved request running and then the completed result", async () => {
    allowAskFirst();
    getTestCallStatusMock.mockResolvedValue(requestStatus("running"));
    await openAndRun(askFirstEntry);
    expect(document.body.textContent).toContain("Approved · running");
    expect(document.body.textContent).not.toContain("Cancel this request");

    getTestCallStatusMock.mockResolvedValue({ ...requestStatus("done"), result: [{ name: "Northstar launch plan" }] });
    await act(async () => { await client.invalidateQueries({ queryKey: ["tools"] }); });
    await flushReact();
    expect(document.body.textContent).toContain("Worked.");
    expect(document.body.textContent).toContain("Northstar launch plan");
    expect(runTestCallMock).toHaveBeenCalledTimes(1);
  });

  it("shows a denied request without offering cancellation", async () => {
    allowAskFirst();
    getTestCallStatusMock.mockResolvedValue(requestStatus("denied"));
    await openAndRun(askFirstEntry);
    expect(document.body.textContent).toContain("Denied — see Review for why");
    expect(document.body.textContent).not.toContain("Cancel this request");
  });

  it("shows a tool error and opens its raw response", async () => {
    runTestCallMock.mockResolvedValue({
      decision: "allowed", invocationId: "error",
      result: { content: "Asana denied access to this workspace.", data: { content: [{ type: "text", text: "Asana denied access to this workspace." }], isError: true }, error: "MCP tool returned an error result" },
    });
    await openAndRun();
    expect(document.body.textContent).toContain("It didn't work.");
    expect(document.body.textContent).toContain("Asana denied access to this workspace.");
    expect(document.body.textContent).toContain("Hide raw response");
  });

  it("opens the raw response when an MCP block has an unexpected shape", async () => {
    runTestCallMock.mockResolvedValue({
      decision: "allowed", invocationId: "malformed",
      result: { content: "", data: { content: [{ type: "text", payload: "missing text" }], structuredContent: null, isError: false } },
    });
    await openAndRun();
    expect(document.body.textContent).toContain("Hide raw response");
    expect(document.body.textContent).toContain("missing text");
  });

  it("keeps useful and generic error hints", () => {
    expect(errorHints("Not found", "NOT_FOUND").join(" ")).toMatch(/check|verify|ID/i);
    expect(errorHints("Unexpected provider failure", null).length).toBeGreaterThan(0);
  });
});
