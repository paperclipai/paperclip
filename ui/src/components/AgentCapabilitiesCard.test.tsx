// @vitest-environment jsdom

import { act, type ReactElement } from "react";
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

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function renderWithClient(container: HTMLDivElement, element: ReactElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

  await act(async () => {
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });

  return root;
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

  it("renders a governed capability workspace shell with desired-config posture labels", async () => {
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

    const root = await renderWithClient(
      container,
      <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />,
    );
    await flush();

    expect(mockGetCapabilities).toHaveBeenCalledWith("agent-1", "company-1");
    const text = container.textContent ?? "";
    expect(text).toContain("Capability workspace");
    expect(text).toContain("MCP / skills / tools capabilities");
    expect(text).toContain("BACKEND-BACKED");
    expect(text).toContain("DESIRED CONFIG ONLY");
    expect(text).toContain("APPROVAL REQUIRED");
    expect(text).toContain("LIVE APPLY DISABLED");
    expect(text).toContain("Source scopeAgent local");
    expect(text).toContain("MCP servers1");
    expect(text).toContain("Skills1");
    expect(text).toContain("Tools1");
    expect(text).toContain("Knowledge refs0");
    expect(text).toContain("Paperclip MCP");
    expect(text).toContain("Desired state: enabled");
    expect(text).toContain("Live posture: not_installed (server-owned)");
    expect(text).toContain("Required named secrets: PAPERCLIP_API_KEY");
    expect(text).toContain("Paperclip MCP preset is saved as desired config only; it does not install, connect, or execute.");

    const advancedJson = container.querySelector("details");
    expect(advancedJson?.open).toBe(false);
    expect(advancedJson?.querySelector("summary")?.textContent).toContain("Advanced JSON");
    expect(advancedJson?.querySelector("textarea")?.getAttribute("aria-label")).toBe("Capability desired config JSON");

    await act(async () => root.unmount());
  });

  it("saves edited desired config through the real capabilities API from the Advanced JSON fallback", async () => {
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

    const root = await renderWithClient(
      container,
      <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />,
    );
    await flush();

    const addPresetButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add Paperclip MCP preset"),
    );
    expect(addPresetButton).toBeTruthy();

    await act(async () => {
      addPresetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const advancedJson = container.querySelector("details");
    expect(advancedJson?.querySelector("summary")?.textContent).toContain("Advanced JSON");
    const saveButton = Array.from(advancedJson?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Save desired config"),
    );
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
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

    await act(async () => root.unmount());
  });

  it("renders no-live-action copy while loading", async () => {
    mockGetCapabilities.mockReturnValue(new Promise(() => undefined));

    const root = await renderWithClient(
      container,
      <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Loading capability workspace…");
    expect(text).toContain("No live action occurred.");
    expect(text).toContain("BACKEND-BACKED");
    expect(text).toContain("DESIRED CONFIG ONLY");

    await act(async () => root.unmount());
  });

  it("renders no-live-action copy when loading fails", async () => {
    mockGetCapabilities.mockRejectedValue(new Error("network down"));

    const root = await renderWithClient(
      container,
      <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />,
    );
    await flush();

    const text = container.textContent ?? "";
    expect(text).toContain("Failed to load capabilities. No live action occurred.");
    expect(text).toContain("no MCP install, connect, execute, or external action was attempted");
    expect(text).toContain("Retry loading desired config");

    await act(async () => root.unmount());
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

    const root = await renderWithClient(
      container,
      <CompanyCapabilityDefaultsCard companyId="company-1" />,
    );
    await flush();

    const text = container.textContent ?? "";
    expect(mockGetCompanyCapabilities).toHaveBeenCalledWith("company-1");
    expect(text).toContain("Global MCP / skills / tools defaults");
    expect(text).toContain("Source scopeCompany global");
    expect(text).toContain("No global desired MCP defaults saved yet.");

    const addPresetButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Add Paperclip MCP preset"),
    );
    await act(async () => {
      addPresetButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const advancedJson = container.querySelector("details");
    const saveButton = Array.from(advancedJson?.querySelectorAll("button") ?? []).find((button) =>
      button.textContent?.includes("Save desired config"),
    );
    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();

    expect(mockUpdateCompanyCapabilities).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        mcpServers: [expect.objectContaining({ id: "paperclip-local", liveState: "not_installed" })],
        liveApply: false,
        liveExternalActions: false,
      }),
    );

    await act(async () => root.unmount());
  });
});
