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

// flush drives React's microtask queue + one macrotask so useQuery/useMutation
// state updates are committed before assertions run. This replaces the
// deprecated react-dom/test-utils.act pattern which is not available from the
// react ESM build under vitest in React 19.
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

function renderInClient(container: HTMLElement, element: React.ReactElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  return root;
}

async function clickByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`Button with text "${text}" not found`);
  button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flush();
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
    // Provide a default resolved value for the company defaults query so that
    // useQuery never returns undefined, which avoids the
    // "Query data cannot be undefined" warning in tests focused on the
    // agent-local card only.
    mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders persisted desired MCP config and keeps live apply gated", async () => {
    mockGetCapabilities.mockResolvedValue(
      response({
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
      }),
    );

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    expect(mockGetCapabilities).toHaveBeenCalledWith("agent-1", "company-1");
    expect(container.textContent).toContain("Real persisted desired config");
    expect(container.textContent).toContain("no live MCP install/execution");
    expect(container.textContent).toContain("Paperclip MCP");
    expect(container.textContent).toContain("not_installed");
    expect(container.textContent).toContain("PAPERCLIP_API_KEY");
    expect(container.textContent).toContain("Effective Preview (read-only)");
    expect(container.textContent).toContain("from agent local");
    expect(container.textContent).toContain("Advanced JSON fallback");
    expect(container.textContent).toContain("Format JSON");
    expect(container.textContent).toContain("Reset to last saved");

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

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("from global defaults"));

    const effectiveJson = container.querySelector(
      'textarea[aria-label="Effective capability config JSON"]',
    ) as HTMLTextAreaElement | null;
    expect(effectiveJson?.value).toContain('"id": "global-only"');
    expect(effectiveJson?.value).toContain('"skillRefs": [');
    expect(effectiveJson?.value).toContain('"global-skill"');

    root.unmount();
  });

  // Regression test for LET-281: local partial config must not wipe unrelated
  // global/default capability values. Per-category fallback semantics:
  // for each of mcpServers/skillRefs/toolRefs, if the agent-local config has
  // entries for that category it is authoritative for that category only;
  // empty categories fall back to the global default for that category.
  it("local partial config inherits untouched categories from global defaults (LET-281 regression)", async () => {
    mockGetCapabilities.mockResolvedValue(
      response({
        config: {
          version: 1,
          // Only tools are specified locally; MCP and skills are empty.
          mcpServers: [],
          skillRefs: [],
          toolRefs: ["local-tool"],
          liveApply: false,
          liveExternalActions: false,
        },
      }),
    );
    mockGetCompanyCapabilities.mockResolvedValue(
      response({
        scope: "company_default",
        agentId: null,
        config: {
          version: 1,
          mcpServers: [
            {
              id: "global-mcp",
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
          toolRefs: ["global-tool-that-should-be-overridden"],
          liveApply: false,
          liveExternalActions: false,
        },
      }),
    );

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("Effective Preview (read-only)"));

    const effectiveJson = container.querySelector(
      'textarea[aria-label="Effective capability config JSON"]',
    ) as HTMLTextAreaElement | null;
    expect(effectiveJson, "effective preview textarea should render").toBeTruthy();

    // MCP and skills inherit from global defaults; tools come from local.
    expect(effectiveJson?.value).toContain('"id": "global-mcp"');
    expect(effectiveJson?.value).toContain('"global-skill"');
    expect(effectiveJson?.value).toContain('"local-tool"');
    expect(effectiveJson?.value).not.toContain("global-tool-that-should-be-overridden");

    // Per-category source labels confirm which scope each category resolved from.
    expect(container.textContent).toContain("MCP/skills from global defaults");
    expect(container.textContent).toContain("tools from agent local");

    root.unmount();
  });

  it("saves edited desired config through the real capabilities API", async () => {
    mockGetCapabilities.mockResolvedValue(response());
    mockUpdateCapabilities.mockResolvedValue(
      response({
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
      }),
    );

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => {
      const btn = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Add Paperclip MCP preset"),
      );
      expect(btn).toBeTruthy();
    });

    await clickByText(container, "Add Paperclip MCP preset");
    await clickByText(container, "Save desired config");
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

  it("Reset to last saved restores the last persisted desired config", async () => {
    mockGetCapabilities.mockResolvedValue(
      response({
        config: {
          version: 1,
          mcpServers: [],
          skillRefs: ["original-skill"],
          toolRefs: [],
          liveApply: false,
          liveExternalActions: false,
        },
      }),
    );

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("Advanced JSON fallback"));

    // Dirty the draft via the Paperclip preset button (safe path through
    // React state — no synthetic input event needed).
    await clickByText(container, "Add Paperclip MCP preset");

    const dirtied = container.querySelector(
      'textarea[aria-label="Capability desired config JSON"]',
    ) as HTMLTextAreaElement | null;
    expect(dirtied?.value).toContain("paperclip-local");
    expect(dirtied?.value).toContain('"original-skill"');

    await clickByText(container, "Reset to last saved");

    const refreshed = container.querySelector(
      'textarea[aria-label="Capability desired config JSON"]',
    ) as HTMLTextAreaElement | null;
    expect(refreshed?.value).toContain('"original-skill"');
    expect(refreshed?.value).not.toContain("paperclip-local");

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

    const root = renderInClient(container, <CompanyCapabilityDefaultsCard companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("Global MCP / skills / tools defaults"));

    expect(mockGetCompanyCapabilities).toHaveBeenCalledWith("company-1");
    expect(container.textContent).toContain("No global desired MCP defaults saved yet.");
    // The global defaults card never shows an Effective Preview (agent-local only).
    expect(container.textContent).not.toContain("Effective Preview (read-only)");

    await clickByText(container, "Add Paperclip MCP preset");
    await clickByText(container, "Save desired config");
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
