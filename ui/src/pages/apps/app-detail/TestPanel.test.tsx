// @vitest-environment jsdom

import { flushSync } from "react-dom";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCatalogEntry } from "@paperclipai/shared";
import { TestPanel, errorHints } from "./TestPanel";

const listTestAgentsMock = vi.hoisted(() => vi.fn());
const runTestCallMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({
  toolsApi: {
    listTestAgents: (connectionId: string) => listTestAgentsMock(connectionId),
    runTestCall: (connectionId: string, input: unknown) => runTestCallMock(connectionId, input),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1", selectedCompany: { id: "company-1", name: "Paperclip" } }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
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

/** The form field input — excludes the "Find an action" search box. */
function formInput(): HTMLInputElement {
  const inputs = [...container.querySelectorAll("input")].filter(
    (i) => i.getAttribute("aria-label") !== "Find an action",
  );
  return inputs[0] as HTMLInputElement;
}

async function fillFormField(value: string) {
  const input = formInput();
  expect(input).toBeTruthy();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flushReact();
}

/** Wait past the 200ms minimum-spinner delay so the result panel renders. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => window.setTimeout(resolve, 260));
  });
  await flushReact();
}

async function clickByText(text: string) {
  const btn = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  expect(btn).toBeTruthy();
  await act(async () => btn!.click());
  await flushReact();
}

function catalogEntry(overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry {
  return {
    id: "catalog-read",
    companyId: "company-1",
    applicationId: "app-1",
    connectionId: "conn-1",
    entryKind: "tool",
    toolName: "read_sheet",
    title: "Read a sheet",
    description: "Get rows and cell values from a sheet.",
    inputSchema: {
      type: "object",
      properties: { spreadsheetId: { type: "string", title: "Spreadsheet" } },
      required: ["spreadsheetId"],
    },
    outputSchema: null,
    annotations: null,
    riskLevel: "read",
    isReadOnly: true,
    isWrite: false,
    isDestructive: false,
    status: "active",
    addedAt: new Date("2026-01-01T00:00:00Z"),
    version: null,
    schemaHash: null,
    firstSeenAt: new Date("2026-01-01T00:00:00Z"),
    lastSeenAt: new Date("2026-01-01T00:00:00Z"),
    reviewedAt: null,
    reviewedByAgentId: null,
    reviewedByUserId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as ToolCatalogEntry;
}

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-claude",
    name: "ClaudeCoder",
    role: "engineer",
    title: "Engineer",
    status: "active",
    effectiveAccess: {
      connectionId: "conn-1",
      toolCount: 3,
      allowedCount: 1,
      askFirstCount: 1,
      offCount: 1,
      tools: [
        { toolName: "read_sheet", gatewayToolName: "gs__read_sheet", displayName: "Read a sheet", risk: "read", decision: "allowed", reasonCode: null, matchedPolicyIds: [] },
        { toolName: "append_row", gatewayToolName: "gs__append_row", displayName: "Append a row", risk: "write", decision: "ask_first", reasonCode: null, matchedPolicyIds: [] },
        { toolName: "delete_row", gatewayToolName: "gs__delete_row", displayName: "Delete a row", risk: "destructive", decision: "off", reasonCode: null, matchedPolicyIds: [] },
      ],
    },
    ...overrides,
  };
}

const readEntry = catalogEntry();
const writeAskEntry = catalogEntry({
  id: "catalog-append",
  toolName: "append_row",
  title: "Append a row",
  description: "Add a new row to the bottom of a sheet.",
  isReadOnly: false,
  isWrite: true,
  riskLevel: "write",
});
const offEntry = catalogEntry({
  id: "catalog-delete",
  toolName: "delete_row",
  title: "Delete a row",
  description: "Remove a row from a sheet permanently.",
  isReadOnly: false,
  isWrite: true,
  isDestructive: true,
  riskLevel: "destructive",
});

let container: HTMLDivElement;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let root: any;

function renderPanel(active: ToolCatalogEntry[] = [readEntry, writeAskEntry, offEntry]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root.render(
    <QueryClientProvider client={client}>
      <TestPanel connectionId="conn-1" appName="Google Sheets" active={active} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  listTestAgentsMock.mockReset();
  runTestCallMock.mockReset();
  listTestAgentsMock.mockResolvedValue({ agents: [agent()] });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("TestPanel", () => {
  it("renders the Test-as header and grouped actions with access badges", async () => {
    await act(async () => renderPanel());
    await flushReact();

    expect(container.textContent).toContain("Test as");
    expect(container.textContent).toContain("ClaudeCoder");
    expect(container.textContent).toContain("Allowed for 1 action · Ask first for 1 action · Off for 1 action");
    expect(container.textContent).toContain("Read (1)");
    expect(container.textContent).toContain("Write (2)");
    // Each action shows its decision badge.
    expect(container.textContent).toContain("Allowed");
    expect(container.textContent).toContain("Ask first");
    expect(container.textContent).toContain("Off");
  });

  it("shows the empty state when there are no actions", async () => {
    await act(async () => renderPanel([]));
    await flushReact();
    expect(container.textContent).toContain("Nothing to test yet");
    expect(container.textContent).toContain("Go to Setup");
  });

  it("renders an allowed result panel with a row-count headline after a successful run", async () => {
    runTestCallMock.mockResolvedValue({
      decision: "allowed",
      invocationId: "inv-1",
      result: [
        { name: "Acme", stage: "Demo" },
        { name: "Globex", stage: "Trial" },
      ],
    });
    await act(async () => renderPanel());
    await flushReact();

    // Expand the allowed (read) action.
    const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Read a sheet"));
    expect(trigger).toBeTruthy();
    await act(async () => trigger!.click());
    await flushReact();

    // Fill the required field then Run.
    await fillFormField("sheet-123");
    await clickByText("Run");
    await settle();

    expect(runTestCallMock).toHaveBeenCalledWith("conn-1", {
      agentId: "agent-claude",
      toolName: "read_sheet",
      parameters: { spreadsheetId: "sheet-123" },
    });
    expect(container.textContent).toContain("Worked. 2 rows came back.");
    expect(container.textContent).toContain("Ran as ClaudeCoder");
    expect(container.textContent).toContain("Preview");
  });

  it("renders the ask-first card linking to Review", async () => {
    runTestCallMock.mockResolvedValue({ decision: "ask_first", invocationId: "inv-2", actionRequestId: "req-1" });
    await act(async () => renderPanel());
    await flushReact();

    const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Append a row"));
    await act(async () => trigger!.click());
    await flushReact();

    await fillFormField("sheet-123");
    await clickByText("Run");
    await settle();

    expect(container.textContent).toContain("Sent for your OK.");
    expect(container.textContent).toContain("Cancel this request");
    const reviewLink = [...container.querySelectorAll("a")].find((a) => a.textContent?.includes("Open Review tab"));
    expect(reviewLink?.getAttribute("href")).toBe("/apps/conn-1/review");
  });

  it("explains an off action and links to Permissions without calling the API", async () => {
    await act(async () => renderPanel());
    await flushReact();

    const trigger = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Delete a row"));
    await act(async () => trigger!.click());
    await flushReact();

    expect(container.textContent).toContain("Delete a row is off for ClaudeCoder.");
    const permLink = [...container.querySelectorAll("a")].find((a) => a.getAttribute("href") === "/apps/conn-1/permissions");
    expect(permLink).toBeTruthy();
    // No Run button is offered for an off action.
    expect([...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Run")).toBe(false);
    expect(runTestCallMock).not.toHaveBeenCalled();
  });
});

describe("errorHints", () => {
  it("maps known reason codes to tailored hints", () => {
    expect(errorHints("Requested entity was not found.", "NOT_FOUND").length).toBeGreaterThan(0);
    expect(errorHints("permission denied", "PERMISSION_DENIED")[0]).toContain("permission");
    expect(errorHints("bad input", "INVALID_ARGUMENT").length).toBeGreaterThan(0);
    expect(errorHints("slow down", "RATE_LIMIT")[0]).toContain("rate-limit");
  });

  it("returns the locked generic fallback for an unknown error", () => {
    expect(errorHints("boom", "tool_execution_failed")).toEqual(["Check the inputs above and try again."]);
  });
});
