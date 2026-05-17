// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCapabilitiesCard, CompanyCapabilityDefaultsCard } from "./AgentCapabilitiesCard";
import { mcpPresetCatalog } from "./capabilityMarketplaceCatalog";
import capabilityMarketplaceCatalogSource from "./capabilityMarketplaceCatalog.ts?raw";

const mockGetCapabilities = vi.hoisted(() => vi.fn());
const mockUpdateCapabilities = vi.hoisted(() => vi.fn());
const mockPreviewCapabilities = vi.hoisted(() => vi.fn());
const mockGetCompanyCapabilities = vi.hoisted(() => vi.fn());
const mockUpdateCompanyCapabilities = vi.hoisted(() => vi.fn());
const mockPreviewCompanyCapabilities = vi.hoisted(() => vi.fn());

vi.mock("../api/agents", () => ({
  agentsApi: {
    getCapabilities: mockGetCapabilities,
    updateCapabilities: mockUpdateCapabilities,
    previewCapabilityApply: mockPreviewCapabilities,
  },
}));

vi.mock("../api/companies", () => ({
  companiesApi: {
    getCapabilities: mockGetCompanyCapabilities,
    updateCapabilities: mockUpdateCompanyCapabilities,
    previewCapabilityApply: mockPreviewCompanyCapabilities,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// flush drives React's microtask queue + one macrotask, wrapped in act() so
// useQuery/useMutation state updates are committed before assertions run and
// no "not wrapped in act(...)" warnings are emitted. React 19 exports act from
// "react" itself, so we can use it without the legacy react-dom/test-utils
// path.
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
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

function renderInClient(container: HTMLElement, element: React.ReactElement): Root {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let root: Root;
  act(() => {
    root = createRoot(container);
    root.render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
  });
  return root!;
}

async function clickByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`Button with text "${text}" not found`);
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function clickTab(container: HTMLElement, label: string) {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).find(
    (button) => button.textContent?.trim().startsWith(label),
  );
  if (!tab) throw new Error(`Tab not found: ${label}`);
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function unmount(root: Root) {
  await act(async () => {
    root.unmount();
  });
}

describe("AgentCapabilitiesCard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockGetCapabilities.mockReset();
    mockUpdateCapabilities.mockReset();
    mockPreviewCapabilities.mockReset();
    mockGetCompanyCapabilities.mockReset();
    mockUpdateCompanyCapabilities.mockReset();
    mockPreviewCompanyCapabilities.mockReset();
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

  it("renders persisted desired MCP config in Summary and keeps live apply gated", async () => {
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

    // Advanced JSON is a disclosure fallback rendered at the bottom of the
    // card; its content is in the DOM even when collapsed.
    expect(container.textContent).toContain("Advanced JSON fallback");
    expect(container.textContent).toContain("Format JSON");
    expect(container.textContent).toContain("Reset to last saved");

    await clickTab(container, "Effective Preview");
    await waitFor(() => expect(container.textContent).toContain("Effective Preview (read-only)"));
    expect(container.textContent).toContain("from agent local");

    await unmount(root);
  });

  it("falls back to global defaults in Effective Preview tab when local config is empty", async () => {
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
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    await clickTab(container, "Effective Preview");
    await waitFor(() => expect(container.textContent).toContain("from global defaults"));

    const effectiveJson = container.querySelector(
      'textarea[aria-label="Effective capability config JSON"]',
    ) as HTMLTextAreaElement | null;
    expect(effectiveJson?.value).toContain('"id": "global-only"');
    expect(effectiveJson?.value).toContain('"skillRefs": [');
    expect(effectiveJson?.value).toContain('"global-skill"');

    await unmount(root);
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
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    await clickTab(container, "Effective Preview");
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

    await unmount(root);
  });

  it("saves edited desired config through the real capabilities API via Summary preset button", async () => {
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

    await unmount(root);
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

    await unmount(root);
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

    await unmount(root);
  });

  it("renders Marketplace tab with MCP presets and no live-action affordance", async () => {
    mockGetCapabilities.mockResolvedValue(response());
    mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    await clickTab(container, "Marketplace");
    await waitFor(() => expect(container.textContent).toContain("Capability marketplace"));

    expect(container.textContent).toContain("desired config only");
    expect(container.textContent).toContain("Paperclip MCP");
    expect(container.textContent).toContain("Filesystem (full read/write)");
    expect(container.textContent).toContain("GitHub MCP server");
    expect(container.textContent).toContain("Fetch (HTTP)");
    expect(container.textContent).toContain("Required named secrets:");
    expect(container.textContent).toContain("never paste raw values here");
    // Risk-honest labels — filesystem/github presets must NOT be marketed as read-only.
    expect(container.textContent).not.toContain("Filesystem (read-only)");
    expect(container.textContent).not.toContain("GitHub (read-only)");

    expect(container.textContent).not.toMatch(/install now/i);
    expect(container.textContent).not.toMatch(/connect now/i);
    expect(container.textContent).not.toMatch(/execute now/i);
    expect(container.textContent).not.toMatch(/apply live/i);

    expect(container.textContent).toContain("Tools");
    expect(container.textContent).toContain("Skills");
    expect(container.textContent).toContain("Knowledge");
    expect(container.textContent).toContain("not implemented");

    await unmount(root);
  });

  it("adds an MCP preset from the Marketplace into the desired-config draft and Advanced JSON reflects it", async () => {
    mockGetCapabilities.mockResolvedValue(response());
    mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    await clickTab(container, "Marketplace");
    await waitFor(() => expect(container.textContent).toContain("Filesystem (full read/write)"));

    const addButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add Filesystem (full read/write) to desired config"]',
    );
    expect(addButton).toBeTruthy();
    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    await waitFor(() => {
      const textarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Capability desired config JSON"]',
      );
      expect(textarea?.value).toContain('"id": "filesystem"');
    });

    const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Capability desired config JSON"]',
    );
    expect(advancedTextarea?.value).toContain('"liveState": "not_installed"');
    expect(advancedTextarea?.value).toContain('"liveApply": false');
    expect(advancedTextarea?.value).toContain('"liveExternalActions": false');

    await unmount(root);
  });

  it("removes a previously-added preset from the desired-config draft", async () => {
    mockGetCapabilities.mockResolvedValue(
      response({
        config: {
          version: 1,
          mcpServers: [
            {
              id: "filesystem",
              provider: "official_registry",
              displayName: "Filesystem (full read/write)",
              transport: "stdio",
              command: "npx -y @modelcontextprotocol/server-filesystem",
              requiredSecretNames: [],
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
    mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    await clickTab(container, "Marketplace");
    await waitFor(() => expect(container.textContent).toContain("Filesystem (full read/write)"));

    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Filesystem (full read/write) from desired config"]',
    );
    expect(removeButton).toBeTruthy();
    await act(async () => {
      removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Capability desired config JSON"]',
    );
    expect(advancedTextarea?.value).not.toContain('"id": "filesystem"');

    await unmount(root);
  });

  // LET-321: Custom MCP server form coverage.
  describe("Custom MCP server form", () => {
    async function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const proto =
        input instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
      const nativeValueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      await act(async () => {
        nativeValueSetter?.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    async function setSelect(select: HTMLSelectElement, value: string) {
      const nativeValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )?.set;
      await act(async () => {
        nativeValueSetter?.call(select, value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    function field<T extends HTMLElement = HTMLInputElement>(label: string): T {
      const el = container.querySelector(`[aria-label="${label}"]`);
      if (!el) throw new Error(`Field with aria-label "${label}" not found`);
      return el as unknown as T;
    }

    async function openCustomTab() {
      await clickTab(container, "Custom");
      await waitFor(() => expect(container.textContent).toContain("Add a custom MCP server"));
    }

    it("adds a valid stdio custom MCP server with named secret reference to the desired-config draft", async () => {
      mockGetCapabilities.mockResolvedValue(response());

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await openCustomTab();

      await setInput(field("Custom MCP id"), "my-custom-mcp");
      await setInput(field("Custom MCP display name"), "My custom MCP");
      await setInput(field("Custom MCP command"), "npx -y @example/mcp-server");
      await setInput(field("Custom MCP required secret names"), "MY_API_KEY, ANOTHER_TOKEN_NAME");

      await clickByText(container, "Add custom MCP to draft");

      const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Capability desired config JSON"]',
      );
      expect(advancedTextarea?.value).toContain('"id": "my-custom-mcp"');
      expect(advancedTextarea?.value).toContain('"provider": "manual"');
      expect(advancedTextarea?.value).toContain('"transport": "stdio"');
      expect(advancedTextarea?.value).toContain('"command": "npx -y @example/mcp-server"');
      expect(advancedTextarea?.value).toContain('"MY_API_KEY"');
      expect(advancedTextarea?.value).toContain('"ANOTHER_TOKEN_NAME"');
      expect(advancedTextarea?.value).toContain('"liveState": "not_installed"');
      expect(advancedTextarea?.value).toContain('"liveApply": false');
      expect(advancedTextarea?.value).toContain('"liveExternalActions": false');

      await unmount(root);
    });

    it("adds a valid remote (streamable_http) custom MCP server only when remoteUrl is provided", async () => {
      mockGetCapabilities.mockResolvedValue(response());

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await openCustomTab();

      await setInput(field("Custom MCP id"), "remote-mcp");
      await setInput(field("Custom MCP display name"), "Remote MCP");
      await setSelect(field<HTMLSelectElement>("Custom MCP transport"), "streamable_http");

      // Missing remoteUrl should block submission.
      await clickByText(container, "Add custom MCP to draft");
      expect(container.textContent).toContain("remote MCP servers must include remoteUrl");

      // Provide the URL and submit again.
      await setInput(field("Custom MCP remote URL"), "https://mcp.example.com/endpoint");
      await clickByText(container, "Add custom MCP to draft");

      const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Capability desired config JSON"]',
      );
      expect(advancedTextarea?.value).toContain('"id": "remote-mcp"');
      expect(advancedTextarea?.value).toContain('"transport": "streamable_http"');
      expect(advancedTextarea?.value).toContain('"remoteUrl": "https://mcp.example.com/endpoint"');

      await unmount(root);
    });

    it("blocks duplicate ids against existing draft entries", async () => {
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
            skillRefs: [],
            toolRefs: [],
            liveApply: false,
            liveExternalActions: false,
          },
        }),
      );

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await openCustomTab();

      await setInput(field("Custom MCP id"), "paperclip-local");
      await setInput(field("Custom MCP display name"), "Should not add");
      await setInput(field("Custom MCP command"), "npx -y other");

      await clickByText(container, "Add custom MCP to draft");

      expect(container.textContent).toContain(
        'An MCP server with id "paperclip-local" already exists in the draft.',
      );

      // Draft must still only contain the original entry (no duplicate appended).
      const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Capability desired config JSON"]',
      );
      const matches = advancedTextarea?.value.match(/"id": "paperclip-local"/g) ?? [];
      expect(matches.length).toBe(1);
      expect(advancedTextarea?.value).not.toContain("Should not add");

      await unmount(root);
    });

    it("blocks invalid secret names that are not env-style identifiers", async () => {
      mockGetCapabilities.mockResolvedValue(response());

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await openCustomTab();

      await setInput(field("Custom MCP id"), "needs-clean-secret");
      await setInput(field("Custom MCP display name"), "Needs clean secret");
      await setInput(field("Custom MCP command"), "npx clean");
      // lower-case + hyphens are not valid env-style identifiers.
      await setInput(field("Custom MCP required secret names"), "lower-case-name");

      await clickByText(container, "Add custom MCP to draft");

      expect(container.textContent).toContain("Secret names must be environment-style identifiers");

      const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Capability desired config JSON"]',
      );
      expect(advancedTextarea?.value).not.toContain('"id": "needs-clean-secret"');

      await unmount(root);
    });

    it("blocks raw secret-like values pasted into free-text fields (notes)", async () => {
      mockGetCapabilities.mockResolvedValue(response());

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await openCustomTab();

      await setInput(field("Custom MCP id"), "no-raw-secret");
      await setInput(field("Custom MCP display name"), "Clean name");
      await setInput(field("Custom MCP command"), "npx clean");
      // Build a bearer-shaped value from fragments so the test still exercises
      // the schema's raw-secret detector without embedding a scanner-tripping
      // literal in the source file (same hygiene pattern as
      // agent-capabilities.test.ts).
      const bearerLeak = `leak: ${["Bear", "er"].join("")} abcdef0123456789ABCDEF`;
      await setInput(field<HTMLTextAreaElement>("Custom MCP notes"), bearerLeak);

      await clickByText(container, "Add custom MCP to draft");

      expect(container.textContent).toContain(
        "Capability config must reference named secrets, not include raw secret values",
      );

      const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Capability desired config JSON"]',
      );
      expect(advancedTextarea?.value).not.toContain('"id": "no-raw-secret"');

      await unmount(root);
    });

    // LET-321 reviewer fix: an uppercase credential shape (e.g. AWS access key
    // id) satisfies the env-style identifier regex on its own, so the schema
    // also has to run the raw-secret detector against each requiredSecretNames
    // entry. This test guards the named-secret field specifically.
    it("blocks credential-shaped values pasted into required secret names", async () => {
      mockGetCapabilities.mockResolvedValue(response());

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await openCustomTab();

      await setInput(field("Custom MCP id"), "leaky-secret-name");
      await setInput(field("Custom MCP display name"), "Leaky secret name");
      await setInput(field("Custom MCP command"), "npx safe");
      // Build an AWS-access-key-shaped value from fragments so the source file
      // does not embed an actual AKIA literal that secret scanners would flag.
      const awsKeyShape = `${"AK" + "IA"}1234567890ABCDEF`;
      await setInput(field("Custom MCP required secret names"), awsKeyShape);

      await clickByText(container, "Add custom MCP to draft");

      expect(container.textContent).toContain(
        "Capability config must reference named secrets, not include raw secret values",
      );

      const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Capability desired config JSON"]',
      );
      expect(advancedTextarea?.value).not.toContain('"id": "leaky-secret-name"');

      await unmount(root);
    });

    it("blocks stdio submission when command is missing", async () => {
      mockGetCapabilities.mockResolvedValue(response());

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await openCustomTab();

      await setInput(field("Custom MCP id"), "missing-cmd");
      await setInput(field("Custom MCP display name"), "Missing command");
      // Leave command empty.

      await clickByText(container, "Add custom MCP to draft");

      expect(container.textContent).toContain("stdio MCP servers must include a command");

      const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Capability desired config JSON"]',
      );
      expect(advancedTextarea?.value).not.toContain('"id": "missing-cmd"');

      await unmount(root);
    });

    it("forces provider=manual and liveState=not_installed even when the form posts a custom entry", async () => {
      mockGetCapabilities.mockResolvedValue(response());

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await openCustomTab();

      await setInput(field("Custom MCP id"), "force-safe-state");
      await setInput(field("Custom MCP display name"), "Force safe state");
      await setInput(field("Custom MCP command"), "npx safe");
      await clickByText(container, "Add custom MCP to draft");

      const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Capability desired config JSON"]',
      );
      expect(advancedTextarea?.value).toContain('"id": "force-safe-state"');
      expect(advancedTextarea?.value).toContain('"provider": "manual"');
      expect(advancedTextarea?.value).toContain('"liveState": "not_installed"');
      expect(advancedTextarea?.value).toContain('"liveApply": false');
      expect(advancedTextarea?.value).toContain('"liveExternalActions": false');

      await unmount(root);
    });
  });

  // LET-321 reviewer fix: a non-array mcpServers value in Advanced JSON used
  // to crash the render when computing existing draft ids. The card must
  // tolerate the malformed value and keep the Advanced JSON fallback usable.
  it("survives a non-array mcpServers value in Advanced JSON without crashing", async () => {
    mockGetCapabilities.mockResolvedValue(response());

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Capability desired config JSON"]',
    );
    expect(advancedTextarea).toBeTruthy();

    const malformed = JSON.stringify(
      {
        version: 1,
        mcpServers: { notAnArray: true },
        skillRefs: [],
        toolRefs: [],
        liveApply: false,
        liveExternalActions: false,
      },
      null,
      2,
    );
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeValueSetter?.call(advancedTextarea, malformed);
      advancedTextarea!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // The Custom tab triggers the existing-id memo path; it must render
    // without throwing even though mcpServers is not iterable as an array.
    await clickTab(container, "Custom");
    await waitFor(() => expect(container.textContent).toContain("Add a custom MCP server"));
    // The malformed draft is still in the Advanced JSON textarea, ready to fix.
    const advancedAfter = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Capability desired config JSON"]',
    );
    expect(advancedAfter?.value).toContain('"notAnArray": true');

    await unmount(root);
  });

  // LET-336: Apply Preview dry-run tab coverage.
  describe("Apply Preview tab (LET-140-F dry-run)", () => {
    function proposal(overrides: Record<string, unknown> = {}) {
      return {
        dryRun: true,
        liveActionPerformed: false,
        liveApply: false,
        liveExternalActions: false,
        scope: "agent_local",
        companyId: "company-1",
        agentId: "agent-1",
        status: "changes_pending_approval",
        approvalRequiredForLiveApply: true,
        proposalIdentity: "acp1:abcdef0123456789",
        generatedAt: "2026-05-17T00:00:00.000Z",
        copy: {
          headline: "Apply Preview — dry-run, changes pending approval",
          dryRunNote:
            "Dry-run only. No live MCP install, connect, execute, apply, or external action occurred from this preview.",
          safetyStatement:
            "Desired-vs-live: this preview describes desired config changes. Live apply, install, connect, execute, and external actions remain approval-gated and are not performed by this endpoint.",
          rollbackNote: "If an approved live apply later proceeds, rollback consists of saving the prior desired config.",
        },
        totals: { additions: 1, removals: 0, updates: 0 },
        riskSummary: { highRiskCount: 1, mediumRiskCount: 0, lowRiskCount: 0 },
        mcpServers: {
          additions: [
            {
              id: "paperclip-local",
              kind: "add",
              displayName: "Paperclip MCP",
              transport: "stdio",
              desiredState: "enabled",
              liveState: "not_installed",
              requiredSecretNames: ["PAPERCLIP_API_KEY"],
              missingSecretNames: ["PAPERCLIP_API_KEY"],
              hasCommand: true,
              hasRemoteUrl: false,
              riskClass: "high",
              approvalRequiredForLiveApply: true,
              changedFields: [],
            },
          ],
          removals: [],
          updates: [],
        },
        skillRefs: { additions: [], removals: [] },
        toolRefs: { additions: [], removals: [] },
        requiredSecretNames: ["PAPERCLIP_API_KEY"],
        missingSecretNames: ["PAPERCLIP_API_KEY"],
        expectedEffects: [
          'Would record desired MCP server "paperclip-local" (stdio). Live install/connect/execute remains approval-gated; no live action occurs from this preview.',
        ],
        inheritedContext: { note: "Per-category inheritance applies.", globalDefaultsAvailable: true },
        ...overrides,
      };
    }

    it("renders an idle CTA, then a sanitized proposal with disabled live-apply CTA on click", async () => {
      mockGetCapabilities.mockResolvedValue(response());
      mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));
      mockPreviewCapabilities.mockResolvedValue(proposal());

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await clickTab(container, "Apply Preview");
      await waitFor(() => expect(container.textContent).toContain("Apply Preview (dry-run)"));

      // Idle state copy must reinforce no-live-action posture.
      expect(container.textContent).toContain("Run dry-run preview");
      expect(container.textContent).toContain("Dry-run only");
      expect(container.textContent).toContain("approval-gated");
      expect(container.textContent).not.toMatch(/install now|connect now|execute now|apply live/i);

      await clickByText(container, "Run dry-run preview");
      await waitFor(() => expect(container.textContent).toContain("Apply Preview — dry-run, changes pending approval"));

      // Proposal rendering
      expect(container.textContent).toContain("acp1:abcdef0123456789");
      expect(container.textContent).toContain("Paperclip MCP");
      expect(container.textContent).toContain("PAPERCLIP_API_KEY");
      expect(container.textContent).toContain("Missing named secrets");
      expect(container.textContent).toContain("approval required for live apply");
      // No raw command/url leakage
      expect(container.textContent).not.toContain("npx -y @paperclipai/mcp-server");

      // Live apply CTA is present but disabled and clearly informational.
      const liveCta = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
        b.textContent?.includes("Request live apply"),
      );
      expect(liveCta).toBeTruthy();
      expect(liveCta?.disabled).toBe(true);
      expect(liveCta?.getAttribute("aria-disabled")).toBe("true");

      // Posted payload reaches the API with the current draft.
      expect(mockPreviewCapabilities).toHaveBeenCalledWith(
        "agent-1",
        expect.objectContaining({ draftConfig: expect.objectContaining({ liveApply: false }) }),
        "company-1",
      );

      await unmount(root);
    });

    it("renders no-op state without raw secrets or live-action affordances", async () => {
      mockGetCapabilities.mockResolvedValue(response());
      mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));
      mockPreviewCapabilities.mockResolvedValue(
        proposal({
          status: "no_op",
          approvalRequiredForLiveApply: false,
          totals: { additions: 0, removals: 0, updates: 0 },
          riskSummary: { highRiskCount: 0, mediumRiskCount: 0, lowRiskCount: 0 },
          mcpServers: { additions: [], removals: [], updates: [] },
          requiredSecretNames: [],
          missingSecretNames: [],
          expectedEffects: ["Desired config is already aligned with the draft."],
          copy: {
            headline: "Apply Preview — dry-run, no changes detected",
            dryRunNote: "Dry-run only. No live MCP install, connect, execute, apply, or external action occurred.",
            safetyStatement: "Desired-vs-live: this preview describes desired config only.",
            rollbackNote: "Rollback note unchanged because no changes are proposed.",
          },
        }),
      );

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await clickTab(container, "Apply Preview");
      await clickByText(container, "Run dry-run preview");

      await waitFor(() => expect(container.textContent).toContain("Apply Preview — dry-run, no changes detected"));
      expect(container.textContent).toContain("No-op");
      expect(container.textContent).not.toContain("MCP additions");
      expect(container.textContent).not.toContain("MCP removals");
      expect(container.textContent).not.toMatch(/install now|connect now|execute now|apply live/i);

      await unmount(root);
    });

    it("renders the error state and keeps copy saying no live action occurred", async () => {
      mockGetCapabilities.mockResolvedValue(response());
      mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));
      mockPreviewCapabilities.mockRejectedValue(new Error("preview unavailable"));

      const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

      await clickTab(container, "Apply Preview");
      await clickByText(container, "Run dry-run preview");

      await waitFor(() => expect(container.textContent).toContain("Failed to compute Apply Preview"));
      expect(container.textContent).toContain("No live action occurred");

      await unmount(root);
    });

    it("Apply Preview tab on the company defaults card targets the company preview endpoint", async () => {
      mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));
      mockPreviewCompanyCapabilities.mockResolvedValue(
        proposal({ scope: "company_default", agentId: null, inheritedContext: null }),
      );

      const root = renderInClient(container, <CompanyCapabilityDefaultsCard companyId="company-1" />);
      await waitFor(() => expect(container.textContent).toContain("Global MCP / skills / tools defaults"));

      await clickTab(container, "Apply Preview");
      await clickByText(container, "Run dry-run preview");

      await waitFor(() => expect(container.textContent).toContain("Apply Preview — dry-run, changes pending approval"));
      expect(mockPreviewCompanyCapabilities).toHaveBeenCalledWith(
        "company-1",
        expect.objectContaining({ draftConfig: expect.objectContaining({ liveApply: false }) }),
      );

      await unmount(root);
    });
  });

  it("preserves Advanced JSON fallback content when switching tabs", async () => {
    mockGetCapabilities.mockResolvedValue(response());
    mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));

    const root = renderInClient(container, <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />);
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    // Advanced JSON disclosure textarea is always in DOM; edit it directly.
    const advancedTextareaBefore = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Capability desired config JSON"]',
    );
    expect(advancedTextareaBefore).toBeTruthy();

    const customDraft = JSON.stringify(
      {
        version: 1,
        mcpServers: [],
        skillRefs: ["custom-skill"],
        toolRefs: [],
        liveApply: false,
        liveExternalActions: false,
      },
      null,
      2,
    );
    const nativeValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      nativeValueSetter?.call(advancedTextareaBefore, customDraft);
      advancedTextareaBefore!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await clickTab(container, "Marketplace");
    await clickTab(container, "Summary");

    const advancedTextareaAfter = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Capability desired config JSON"]',
    );
    expect(advancedTextareaAfter?.value).toContain('"custom-skill"');

    await unmount(root);
  });
});

describe("capabilityMarketplaceCatalog raw-secret hygiene (LET-294 N3)", () => {
  const rawSecretPatterns: { name: string; pattern: RegExp }[] = [
    { name: "GitHub classic PAT (ghp_)", pattern: /\bghp_[A-Za-z0-9]{16,}/ },
    { name: "GitHub OAuth (gho_)", pattern: /\bgho_[A-Za-z0-9]{16,}/ },
    { name: "GitHub user-to-server (ghu_)", pattern: /\bghu_[A-Za-z0-9]{16,}/ },
    { name: "GitHub server-to-server (ghs_)", pattern: /\bghs_[A-Za-z0-9]{16,}/ },
    { name: "GitHub fine-grained PAT (github_pat_)", pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}/ },
    { name: "OpenAI key (sk-)", pattern: /\bsk-[A-Za-z0-9]{20,}/ },
    { name: "Stripe live secret key (sk_live_)", pattern: /\bsk_live_[A-Za-z0-9]{16,}/ },
    { name: "Stripe test secret key (sk_test_)", pattern: /\bsk_test_[A-Za-z0-9]{16,}/ },
    { name: "Slack token (xoxa-/xoxb-/xoxp-/xoxs-)", pattern: /\bxox[abps]-[A-Za-z0-9-]{10,}/ },
    { name: "Generic personal-access prefix (pat_)", pattern: /\bpat_[A-Za-z0-9]{16,}/ },
    { name: "AWS access key id (AKIA…)", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: "Google API key (AIza…)", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
    { name: "JWT-shaped token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
    { name: "Bearer token literal", pattern: /\bBearer\s+[A-Za-z0-9_.-]{12,}/ },
  ];

  const catalogSource = capabilityMarketplaceCatalogSource;

  it("catalog source file contains no raw-secret literals", () => {
    for (const { name, pattern } of rawSecretPatterns) {
      expect(
        pattern.test(catalogSource),
        `capabilityMarketplaceCatalog.ts must not embed ${name}`,
      ).toBe(false);
    }
  });

  it("every catalog preset references env-variable names only — never raw values", () => {
    for (const preset of mcpPresetCatalog) {
      const serialized = JSON.stringify(preset);
      for (const { name, pattern } of rawSecretPatterns) {
        expect(
          pattern.test(serialized),
          `Preset "${preset.id}" must not contain ${name}`,
        ).toBe(false);
      }
      for (const secretName of preset.requiredSecretNames) {
        // Env-variable names: UPPER_SNAKE_CASE with no spaces, ≤ 96 chars.
        expect(secretName).toMatch(/^[A-Z][A-Z0-9_]{0,95}$/);
      }
    }
  });
});
