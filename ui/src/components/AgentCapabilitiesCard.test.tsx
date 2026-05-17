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
