// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
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

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

function clickTab(container: HTMLElement, label: string) {
  const tab = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')).find(
    (button) => button.textContent?.trim().startsWith(label),
  );
  if (!tab) throw new Error(`Tab not found: ${label}`);
  tab.dispatchEvent(new MouseEvent("click", { bubbles: true }));
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

  it("renders persisted desired MCP config in Summary and keeps live apply gated", async () => {
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

    clickTab(container, "Effective Preview");
    await flush();
    await waitFor(() => expect(container.textContent).toContain("Effective Preview (read-only)"));
    expect(container.textContent).toContain("resolve from agent local");

    root.unmount();
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

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    clickTab(container, "Effective Preview");
    await flush();
    await waitFor(() => expect(container.textContent).toContain("resolve from global defaults"));

    const effectiveJson = container.querySelector('textarea[aria-label="Effective capability config JSON"]') as HTMLTextAreaElement | null;
    expect(effectiveJson?.value).toContain('"id": "global-only"');
    expect(effectiveJson?.value).toContain('"skillRefs": [');
    expect(effectiveJson?.value).toContain('"global-skill"');

    root.unmount();
  });

  it("saves edited desired config through the real capabilities API via Summary preset button", async () => {
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
    await waitFor(() => expect(findButtonByText(container, "Add Paperclip MCP preset")).toBeTruthy());

    findButtonByText(container, "Add Paperclip MCP preset")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const saveButton = findButtonByText(container, "Save desired config");
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

    findButtonByText(container, "Add Paperclip MCP preset")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    const saveButton = findButtonByText(container, "Save desired config");
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

  it("renders Marketplace tab with MCP presets and no live-action affordance", async () => {
    mockGetCapabilities.mockResolvedValue(response());
    mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    clickTab(container, "Marketplace");
    await flush();
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

    root.unmount();
  });

  it("adds an MCP preset from the Marketplace into the desired-config draft and Advanced JSON reflects it", async () => {
    mockGetCapabilities.mockResolvedValue(response());
    mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    clickTab(container, "Marketplace");
    await flush();
    await waitFor(() => expect(container.textContent).toContain("Filesystem (full read/write)"));

    const addButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add Filesystem (full read/write) to desired config"]',
    );
    expect(addButton).toBeTruthy();
    addButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    clickTab(container, "Advanced JSON");
    await flush();
    await waitFor(() => {
      const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Capability desired config JSON"]');
      expect(textarea?.value).toContain('"id": "filesystem"');
    });

    const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Capability desired config JSON"]',
    );
    expect(advancedTextarea?.value).toContain('"liveState": "not_installed"');
    expect(advancedTextarea?.value).toContain('"liveApply": false');
    expect(advancedTextarea?.value).toContain('"liveExternalActions": false');

    root.unmount();
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

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    clickTab(container, "Marketplace");
    await flush();
    await waitFor(() => expect(container.textContent).toContain("Filesystem (full read/write)"));

    const removeButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove Filesystem (full read/write) from desired config"]',
    );
    expect(removeButton).toBeTruthy();
    removeButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flush();

    clickTab(container, "Advanced JSON");
    await flush();
    const advancedTextarea = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Capability desired config JSON"]',
    );
    expect(advancedTextarea?.value).not.toContain('"id": "filesystem"');

    root.unmount();
  });

  it("preserves Advanced JSON fallback content when switching tabs", async () => {
    mockGetCapabilities.mockResolvedValue(response());
    mockGetCompanyCapabilities.mockResolvedValue(response({ scope: "company_default", agentId: null }));

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

    root.render(
      <QueryClientProvider client={queryClient}>
        <AgentCapabilitiesCard agentId="agent-1" companyId="company-1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(container.textContent).toContain("MCP / skills / tools capabilities"));

    clickTab(container, "Advanced JSON");
    await flush();
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
    nativeValueSetter?.call(advancedTextareaBefore, customDraft);
    advancedTextareaBefore!.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();

    clickTab(container, "Summary");
    await flush();
    clickTab(container, "Advanced JSON");
    await flush();

    const advancedTextareaAfter = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Capability desired config JSON"]',
    );
    expect(advancedTextareaAfter?.value).toContain('"custom-skill"');

    root.unmount();
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
