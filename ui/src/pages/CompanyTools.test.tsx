// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyTools } from "./CompanyTools";

const matrixMock = vi.hoisted(() => vi.fn());
const createToolMock = vi.hoisted(() => vi.fn());
const setGrantsMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tool-access", () => ({
  toolAccessApi: {
    matrix: (companyId: string) => matrixMock(companyId),
    createTool: (companyId: string, data: unknown) => createToolMock(companyId, data),
    setGrants: (companyId: string, grants: unknown) => setGrantsMock(companyId, grants),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: {
      id: "company-1",
      name: "Paperclip",
    },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: setBreadcrumbsMock,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function setInputValue(container: HTMLElement, testId: string, value: string) {
  const input = container.querySelector(`[data-testid="${testId}"]`) as HTMLInputElement | HTMLTextAreaElement | null;
  expect(input).toBeTruthy();
  const valueSetter = Object.getOwnPropertyDescriptor(input!.constructor.prototype, "value")?.set;
  await act(async () => {
    valueSetter?.call(input, value);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flushReact();
}

describe("CompanyTools", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    matrixMock.mockResolvedValue({ tools: [], grants: [] });
    listAgentsMock.mockResolvedValue([]);
    createToolMock.mockResolvedValue({
      id: "tool-1",
      companyId: "company-1",
      key: "mcp.gbrain.query",
      label: "GBrain query",
      description: null,
      source: "mcp_tool",
      adapter: "hermes_local",
      serverKey: "gbrain",
      toolName: "query",
      risk: "read",
      supportedModes: ["off", "read"],
      render: { hermes: { mcpServer: "gbrain", includeTool: "query" } },
      metadata: null,
      createdAt: new Date("2026-05-18T00:00:00.000Z"),
      updatedAt: new Date("2026-05-18T00:00:00.000Z"),
    });
    setGrantsMock.mockResolvedValue({ grants: [] });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("creates a catalog entry from the add tool form", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyTools />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    await setInputValue(container, "company-tools-key", "mcp.gbrain.query");
    await setInputValue(container, "company-tools-label", "GBrain query");
    await setInputValue(container, "company-tools-server-key", "gbrain");
    await setInputValue(container, "company-tools-tool-name", "query");
    await setInputValue(
      container,
      "company-tools-render",
      JSON.stringify({ hermes: { mcpServer: "gbrain", includeTool: "query" } }),
    );

    const addButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add tool",
    );
    expect(addButton).toBeTruthy();

    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(createToolMock).toHaveBeenCalledWith("company-1", {
      key: "mcp.gbrain.query",
      label: "GBrain query",
      source: "mcp_tool",
      adapter: "hermes_local",
      risk: "read",
      supportedModes: ["off", "read"],
      serverKey: "gbrain",
      toolName: "query",
      render: { hermes: { mcpServer: "gbrain", includeTool: "query" } },
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("saves only changed grant cells from the matrix", async () => {
    matrixMock.mockResolvedValue({
      tools: [
        {
          id: "tool-1",
          companyId: "company-1",
          key: "mcp.gbrain.query",
          label: "GBrain query",
          description: null,
          source: "mcp_tool",
          adapter: "hermes_local",
          serverKey: "gbrain",
          toolName: "query",
          risk: "read",
          supportedModes: ["off", "read"],
          render: { hermes: { mcpServer: "gbrain", includeTool: "query" } },
          metadata: null,
          createdAt: new Date("2026-05-18T00:00:00.000Z"),
          updatedAt: new Date("2026-05-18T00:00:00.000Z"),
        },
      ],
      grants: [
        {
          id: "grant-1",
          companyId: "company-1",
          agentId: "agent-1",
          toolId: "tool-1",
          mode: "read",
          grantedByUserId: null,
          createdAt: new Date("2026-05-18T00:00:00.000Z"),
          updatedAt: new Date("2026-05-18T00:00:00.000Z"),
        },
      ],
    });
    listAgentsMock.mockResolvedValue([
      { id: "agent-1", name: "Hermes Researcher", role: "researcher", status: "active" },
      { id: "agent-2", name: "Hermes Operator", role: "operator", status: "active" },
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyTools />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const select = container.querySelector(
      'select[aria-label="Hermes Operator GBrain query access"]',
    ) as HTMLSelectElement | null;
    expect(select).toBeTruthy();

    await act(async () => {
      select!.value = "read";
      select!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const applyButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Apply changes",
    );
    expect(applyButton).toBeTruthy();

    await act(async () => {
      applyButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(setGrantsMock).toHaveBeenCalledWith("company-1", [
      { agentId: "agent-2", toolId: "tool-1", mode: "read" },
    ]);

    await act(async () => {
      root.unmount();
    });
  });
});
