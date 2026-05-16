// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCapabilitiesCard, CompanyCapabilityDefaultsCard } from "./AgentCapabilitiesCard";

const mockGetCapabilities = vi.hoisted(() => vi.fn());
const mockUpdateCapabilities = vi.hoisted(() => vi.fn());
const mockGetCompanyCapabilities = vi.hoisted(() => vi.fn());
const mockUpdateCompanyCapabilities = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({
  agentsApi: {
    getCapabilities: mockGetCapabilities,
    updateCapabilities: mockUpdateCapabilities,
  },
}));

vi.mock("../api/companies", () => ({
  companiesApi: {
    getCapabilities: mockGetCompanyCapabilities,
    updateCapabilities: mockUpdateCompanyCapabilities,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function waitFor(check: () => void, timeoutMs = 2000) {
  const started = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - started > timeoutMs) throw error;
      await flush();
    }
  }
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    scope: "agent_local",
    companyId: "company-1",
    agentId: "agent-1",
    config: {
      version: 1,
      mcpServers: [],
      skillRefs: [],
      toolRefs: [],
      liveApply: false,
      liveExternalActions: false,
    },
    applyPreview: {
      dryRunAvailable: true,
      requiresApprovalForLiveApply: true,
      liveApply: false,
      liveExternalActions: false,
    },
    ...overrides,
  };
}

describe("AgentCapabilitiesCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockGetCapabilities.mockReset();
    mockUpdateCapabilities.mockReset();
    mockGetCompanyCapabilities.mockReset();
    mockUpdateCompanyCapabilities.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders persisted desired MCP config and keeps live apply gated", async () => {
    mockGetCapabilities.mockResolvedValue(response({
      config: {
        version: 1,
        mcpServers: [
          {
            id: "paperclip-local",
            provider: "manual",
            displayName: "Paperclip MCP",
            transport: "stdio",
            command: "npx -y @paperclipai/mcp-server",
            requiredSecretNames: ["PAPERCLIP_API_KEY"],
            desiredState: "enabled",
            liveState: "not_installed",
          },
        ],
        skillRefs: ["native-mcp"],
        toolRefs: ["paperclipApiRequest"],
        liveApply: false,
        liveExternalActions: false,
      },
    }));
    mockGetCompanyCapabilities.mockResolvedValue(
      response({
        scope: "company_default",
        agentId: null,
        config: {
          version: 1,
          mcpServers: [
            {
              id: "company-default",
              provider: "manual",
              displayName: "Company Default MCP",
              transport: "stdio",
              command: "npx example-default",
              requiredSecretNames: [],
              desiredState: "enabled",
              liveState: "not_installed",
            },
          ],
          skillRefs: ["default-skill"],
          toolRefs: ["default-tool"],
          liveApply: false,
          liveExternalActions: false,
        },
      }),
    );

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mockGetCapabilities).toHaveBeenCalledWith("agent-1", "company-1"));
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    expect(container.textContent).toContain("MCP / skills / tools capabilities");
    expect(container.textContent).toContain("Real persisted desired config");
    expect(container.textContent).toContain("no live MCP install/execution");
    expect(container.textContent).toContain("Paperclip MCP");
    expect(container.textContent).toContain("not_installed");
    expect(container.textContent).toContain("PAPERCLIP_API_KEY");
    expect(container.textContent).toContain("Effective Preview (read-only)");
    expect(container.textContent).toContain("resolve from agent local");

    root.unmount();
  });

  it("falls back to global defaults in effective preview when local config is empty", async () => {
    mockGetCapabilities.mockResolvedValue(response());
    mockGetCompanyCapabilities.mockResolvedValue(
      response({
        scope: "company_default",
        agentId: null,
        config: {
          version: 1,
          mcpServers: [
            {
              id: "global-only",
              provider: "manual",
              displayName: "Global MCP",
              transport: "stdio",
              command: "npx global-mcp",
              requiredSecretNames: [],
              desiredState: "enabled",
              liveState: "not_installed",
            },
          ],
          skillRefs: ["global-skill"],
          toolRefs: ["global-tool"],
          liveApply: false,
          liveExternalActions: false,
        },
      }),
    );

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(container.textContent).toContain("resolve from global defaults"));

    const effectiveJson = container.querySelector('textarea[aria-label="Effective capability config JSON"]') as HTMLTextAreaElement | null;
    expect(effectiveJson?.value).toContain('"id": "global-only"');
    expect(effectiveJson?.value).toContain('"skillRefs": [');
    expect(effectiveJson?.value).toContain('"global-skill"');

    root.unmount();
  });

  it("saves edited desired config through the real capabilities API", async () => {
    mockGetCapabilities.mockResolvedValue(response());
    mockUpdateCapabilities.mockResolvedValue(response({
      config: {
        version: 1,
        mcpServers: [
          {
            id: "paperclip-local",
            provider: "manual",
            displayName: "Paperclip MCP",
            transport: "stdio",
            command: "npx -y @paperclipai/mcp-server",
            requiredSecretNames: ["PAPERCLIP_API_KEY"],
            desiredState: "enabled",
            liveState: "not_installed",
          },
        ],
        skillRefs: [],
        toolRefs: [],
        liveApply: false,
        liveExternalActions: false,
      },
    }));

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const addPresetButton = Array.from(container.querySelectorAll("button")).find((button) =>
        button.textContent?.includes("Add Paperclip MCP preset"),
      );
      expect(addPresetButton).toBeTruthy();
    });

    const addPresetButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add Paperclip MCP preset"),
    );
    expect(addPresetButton).toBeTruthy();

    addPresetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save desired config"),
    );
    expect(saveButton).toBeTruthy();

    saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    await flush();

    expect(mockUpdateCapabilities).toHaveBeenCalledWith(
      "agent-1",
      expect.objectContaining({
        mcpServers: [expect.objectContaining({ id: "paperclip-local", liveState: "not_installed" })],
        liveApply: false,
        liveExternalActions: false,
      }),
      "company-1",
    );

    root.unmount();
  });

  it("renders and saves company global defaults through the company capabilities API", async () => {
    mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));
    mockUpdateCompanyCapabilities.mockResolvedValue(
      response({
        scope: "company_default",
        agentId: null,
        config: {
          version: 1,
          mcpServers: [],
          skillRefs: ["native-mcp"],
          toolRefs: [],
          liveApply: false,
          liveExternalActions: false,
        },
      }),
    );

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <CompanyCapabilityDefaultsCard companyId="company-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(mockGetCompanyCapabilities).toHaveBeenCalledWith("company-1"));
    await waitFor(() => expect(container.textContent).toContain("Global MCP / skills / tools defaults"));

    expect(container.textContent).toContain("Global MCP / skills / tools defaults");
    expect(container.textContent).toContain("No global desired MCP defaults saved yet.");

    const addPresetButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add Paperclip MCP preset"),
    );
    addPresetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const saveButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save desired config"),
    );
    saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();
    await flush();

    expect(mockUpdateCompanyCapabilities).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        mcpServers: [expect.objectContaining({ id: "paperclip-local", liveState: "not_installed" })],
        liveApply: false,
        liveExternalActions: false,
      }),
    );

    root.unmount();
  });
});
