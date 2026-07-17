// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ToolCatalogEntry,
  ToolPolicy,
  ToolProfileEffectiveSummary,
} from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";

const mockToolsApi = vi.hoisted(() => ({
  getEffectiveProfilesForAgent: vi.fn(),
  listConnections: vi.fn(),
  listPolicies: vi.fn(),
  listCatalog: vi.fn(),
  listAudit: vi.fn(),
  putConnectionInstalls: vi.fn(),
}));

vi.mock("../api/tools", () => ({ toolsApi: mockToolsApi }));

// Render the company-aware Link as a plain anchor so we don't need a Router.
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: unknown }) =>
    createElement("a", { href: to, ...rest }, children as never),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact(cycles = 4) {
  // Multiple cycles let dependent query waves settle (connections → per-connection catalog).
  for (let i = 0; i < cycles; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

function makeCatalogEntry(overrides: Partial<ToolCatalogEntry>): ToolCatalogEntry {
  return {
    id: "cat-1",
    companyId: "company-1",
    applicationId: "app-1",
    connectionId: "conn-1",
    entryKind: "tool",
    toolName: "github.read_repo",
    title: "Read repo",
    description: null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    riskLevel: "read",
    isReadOnly: true,
    isWrite: false,
    isDestructive: false,
    status: "active",
    addedAt: new Date("2026-06-01T00:00:00Z"),
    version: null,
    schemaHash: null,
    firstSeenAt: new Date("2026-06-01T00:00:00Z"),
    lastSeenAt: new Date("2026-06-01T00:00:00Z"),
    reviewedAt: null,
    reviewedByAgentId: null,
    reviewedByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

function makePolicy(overrides: Partial<ToolPolicy>): ToolPolicy {
  return {
    id: "pol-1",
    companyId: "company-1",
    name: "Require approval for writes",
    description: "All write tools need board approval",
    policyType: "require_approval",
    priority: 100,
    enabled: true,
    selectors: {},
    conditions: null,
    config: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  };
}

describe("AgentToolsTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockToolsApi.getEffectiveProfilesForAgent.mockReset();
    mockToolsApi.listConnections.mockReset();
    mockToolsApi.listPolicies.mockReset();
    mockToolsApi.listCatalog.mockReset();
    mockToolsApi.putConnectionInstalls.mockReset();
    mockToolsApi.putConnectionInstalls.mockResolvedValue({ connectionId: "conn-1", installs: [] });
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  async function renderTab() {
    const { AgentToolsTab } = await import("./AgentToolsTab");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const agent = { id: "agent-1", name: "Coder" } as never;
    await act(async () => {
      root = createRoot(container);
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(AgentToolsTab, { agent, companyId: "company-1" }),
        ),
      );
    });
    await flushReact();
  }

  it("preserves checkbox changes made after the last saved install state", async () => {
    const { mergeInstallDraft } = await import("./AgentToolsTab");

    expect(
      mergeInstallDraft(
        { "conn-1": true, "conn-2": false },
        { "conn-1": true, "conn-2": true },
        { "conn-1": false, "conn-2": false },
      ),
    ).toEqual({
      draft: { "conn-1": true, "conn-2": true },
      hasPendingChanges: true,
    });
  });

  it("renders effective access, access profiles, governing policy, and unavailable tools", async () => {
    const allowed = makeCatalogEntry({ id: "cat-allow", toolName: "github.read_repo" });
    const denied = makeCatalogEntry({
      id: "cat-deny",
      toolName: "github.delete_repo",
      riskLevel: "critical",
      isReadOnly: false,
      isWrite: true,
      isDestructive: true,
    });

    mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-1",
      profiles: [
        {
          id: "prof-1",
          companyId: "company-1",
          profileKey: "github-safe",
          name: "GitHub safe",
          description: null,
          status: "active",
          defaultAction: "deny",
          newToolsReviewedAt: null,
          metadata: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          entries: [],
          bindings: [],
          summary: {
            accessMode: "selected",
            allowedToolCount: 1,
            allowedApplicationCount: 1,
            excludedToolCount: 0,
            totalToolCount: 1,
            assignmentCount: 1,
            appliesToAgentCount: 1,
            isCompanyDefault: true,
          },
        },
      ],
      entries: [],
      bindings: [
        {
          id: "bind-1",
          companyId: "company-1",
          profileId: "prof-1",
          targetType: "agent",
          targetId: "agent-1",
          priority: 100,
          metadata: null,
          createdByAgentId: null,
          createdByUserId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      allowedTools: [allowed],
      allowedToolNames: ["github.read_repo"],
      installedConnections: [],
    } satisfies ToolProfileEffectiveSummary);

    mockToolsApi.listConnections.mockResolvedValue({
      connections: [{ id: "conn-1", name: "Production GitHub" }],
    });
    mockToolsApi.listPolicies.mockResolvedValue({
      policies: [
        makePolicy({ id: "pol-1", name: "Require approval for writes" }),
        makePolicy({
          id: "pol-2",
          name: "Block other agent",
          enabled: true,
          selectors: { agentId: "someone-else" },
        }),
      ],
    });
    mockToolsApi.listCatalog.mockResolvedValue({ catalog: [allowed, denied] });

    await renderTab();

    const text = container.textContent ?? "";
    expect(text).toContain("Effective access");
    expect(text).toContain("github.read_repo");
    expect(text).toContain("Production GitHub");
    expect(text).toContain("GitHub safe");
    expect(text).toContain("Access profiles");
    expect(text).toContain("Company default");
    expect(container.querySelector('a[href="/apps/advanced/profiles/prof-1"]')?.textContent).toBe("GitHub safe");
    expect(container.querySelector('a[href="/apps/advanced/profiles?check=1"]')?.textContent).toBe("Check access");
    // Governing policy #1 is the company-wide require_approval rule.
    expect(text).toContain("#1 Require approval for writes");
    // The policy that targets a different agent must NOT appear.
    expect(text).not.toContain("Block other agent");
    // Unavailable tool surfaced from the full tool list minus allowed.
    expect(text).toContain("github.delete_repo");
  });

  it("shows the empty allow-list message when no profile applies", async () => {
    mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-1",
      profiles: [],
      entries: [],
      bindings: [],
      allowedTools: [],
      allowedToolNames: [],
      installedConnections: [],
    } satisfies ToolProfileEffectiveSummary);
    mockToolsApi.listConnections.mockResolvedValue({ connections: [] });
    mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });

    await renderTab();

    const text = container.textContent ?? "";
    expect(text).toContain("No tools are allowed for this agent");
    expect(text).toContain("No active profile applies");
  });

  it("autosaves installed apps for the current agent", async () => {
    const allowed = makeCatalogEntry({ id: "cat-allow", toolName: "github.read_repo" });
    mockToolsApi.getEffectiveProfilesForAgent.mockResolvedValue({
      agentId: "agent-1",
      profiles: [],
      entries: [],
      bindings: [],
      allowedTools: [allowed],
      allowedToolNames: ["github.read_repo"],
      installedConnections: [],
    } satisfies ToolProfileEffectiveSummary);
    mockToolsApi.listConnections.mockResolvedValue({
      connections: [{ id: "conn-1", companyId: "company-1", name: "Production GitHub", installs: [] }],
    });
    mockToolsApi.listPolicies.mockResolvedValue({ policies: [] });
    mockToolsApi.listCatalog.mockResolvedValue({ catalog: [allowed] });

    await renderTab();

    expect(container.textContent).toContain("Installed apps");
    expect(container.textContent).toContain("Permitted only");
    expect(container.textContent).toContain("Permitted but not installed — tools will not appear in runs.");
    expect(container.querySelector('a[href="/apps/conn-1/permissions"]')?.textContent).toBe("Open permissions");
    const installCheckbox = container.querySelector<HTMLElement>('[aria-label="Install Production GitHub on Coder"]');
    expect(installCheckbox).toBeTruthy();
    await act(async () => {
      installCheckbox!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    });
    await flushReact();

    expect(mockToolsApi.putConnectionInstalls).toHaveBeenCalledWith("conn-1", [
      { targetType: "agent", targetId: "agent-1" },
    ]);
  });
});
