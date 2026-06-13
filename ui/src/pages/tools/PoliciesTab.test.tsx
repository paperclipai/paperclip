// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ToolCatalogEntry, ToolPolicy } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toolsApiMock = vi.hoisted(() => ({
  listPolicies: vi.fn(),
  createPolicy: vi.fn(),
  reorderPolicies: vi.fn(),
  duplicatePolicy: vi.fn(),
  updatePolicy: vi.fn(),
  deletePolicy: vi.fn(),
  listTrustRules: vi.fn(),
  revokeTrustRule: vi.fn(),
  testPolicy: vi.fn(),
  listAudit: vi.fn(),
  listApplications: vi.fn(),
  listConnections: vi.fn(),
  listCatalog: vi.fn(),
}));
const agentsApiMock = vi.hoisted(() => ({ list: vi.fn() }));
const projectsApiMock = vi.hoisted(() => ({ list: vi.fn() }));
const toastMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/tools", () => ({ toolsApi: toolsApiMock }));
vi.mock("@/api/agents", () => ({ agentsApi: agentsApiMock }));
vi.mock("@/api/projects", () => ({ projectsApi: projectsApiMock }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: toastMock }) }));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    className,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    className?: string;
  }) => createElement("button", { type: "button", className, onClick: onSelect }, children),
  DropdownMenuSeparator: () => createElement("hr"),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children: ReactNode }) => (open ? createElement("div", null, children) : null),
  DialogContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogDescription: ({ children }: { children: ReactNode }) => createElement("p", null, children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
}));

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open?: boolean; children: ReactNode }) => (open ? createElement("div", null, children) : null),
  SheetContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  SheetDescription: ({ children }: { children: ReactNode }) => createElement("p", null, children),
  SheetFooter: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  SheetHeader: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  SheetTitle: ({ children }: { children: ReactNode }) => createElement("h2", null, children),
}));

import { PoliciesTab } from "./PoliciesTab";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function policy(partial: Partial<ToolPolicy> & { id: string; policyType: ToolPolicy["policyType"] }): ToolPolicy {
  return {
    id: partial.id,
    companyId: "company-1",
    name: partial.name ?? partial.id,
    description: partial.description ?? null,
    policyType: partial.policyType,
    priority: partial.priority ?? 100,
    enabled: partial.enabled ?? true,
    selectors: partial.selectors ?? {},
    conditions: partial.conditions ?? null,
    config: partial.config ?? null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

function catalog(partial: Partial<ToolCatalogEntry> & { id: string; toolName: string }): ToolCatalogEntry {
  return {
    id: partial.id,
    companyId: "company-1",
    applicationId: partial.applicationId ?? "app-gmail",
    connectionId: partial.connectionId ?? "conn-gmail",
    entryKind: "tool",
    name: partial.name,
    toolName: partial.toolName,
    title: partial.title ?? partial.toolName,
    description: partial.description ?? null,
    inputSchema: null,
    outputSchema: null,
    annotations: null,
    riskLevel: partial.riskLevel ?? "read",
    isReadOnly: partial.isReadOnly ?? true,
    isWrite: partial.isWrite ?? false,
    isDestructive: partial.isDestructive ?? false,
    status: partial.status ?? "active",
    addedAt: new Date("2026-06-01T00:00:00Z"),
    version: null,
    versionHash: null,
    schemaHash: null,
    firstSeenAt: new Date("2026-06-01T00:00:00Z"),
    lastSeenAt: new Date("2026-06-01T00:00:00Z"),
    reviewedAt: null,
    reviewedByAgentId: null,
    reviewedByUserId: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  };
}

async function flushReact() {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

describe("PoliciesTab", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    agentsApiMock.list.mockResolvedValue([{ id: "agent-1", name: "Fable" }]);
    projectsApiMock.list.mockResolvedValue([{ id: "project-1", name: "Launch" }]);
    toolsApiMock.listApplications.mockResolvedValue({ applications: [{ id: "app-gmail", name: "Gmail" }] });
    toolsApiMock.listConnections.mockResolvedValue({ connections: [{ id: "conn-gmail", name: "Gmail" }] });
    toolsApiMock.listCatalog.mockResolvedValue({
      catalog: [
        catalog({ id: "send", toolName: "gmail.send", title: "Send email", riskLevel: "write", isReadOnly: false, isWrite: true }),
        catalog({ id: "delete", toolName: "gmail.delete", title: "Delete email", riskLevel: "destructive", isReadOnly: false, isWrite: true, isDestructive: true }),
      ],
    });
    toolsApiMock.listTrustRules.mockResolvedValue({ trustRules: [] });
    toolsApiMock.listAudit.mockResolvedValue([
      { createdAt: new Date().toISOString(), details: { matchedPolicyIds: ["rule-1"] } },
      { createdAt: new Date().toISOString(), details: { matchedPolicyIds: ["rule-1"] } },
      { createdAt: new Date().toISOString(), details: { matchedPolicyIds: ["rule-1"] } },
    ]);
    toolsApiMock.reorderPolicies.mockResolvedValue({ policies: [] });
    toolsApiMock.duplicatePolicy.mockResolvedValue(policy({ id: "copy", policyType: "block" }));
    toolsApiMock.updatePolicy.mockResolvedValue(policy({ id: "rule-1", policyType: "block" }));
    toolsApiMock.deletePolicy.mockResolvedValue(policy({ id: "rule-1", policyType: "block" }));
    toolsApiMock.revokeTrustRule.mockResolvedValue(policy({ id: "trust-1", policyType: "trust_rule" }));
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(policies: ToolPolicy[]) {
    toolsApiMock.listPolicies.mockResolvedValue({ policies });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={client}>
          <PoliciesTab companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders ordered sentence rows without exposing priority numbers", async () => {
    await render([
      policy({
        id: "rule-1",
        policyType: "require_approval",
        priority: 500,
        selectors: { agentId: "agent-1", riskLevel: "destructive" },
      }),
    ]);

    expect(container.textContent).toContain("Rules are checked top to bottom");
    expect(container.textContent).toContain("When Fable uses destructive actions -> Ask first");
    expect(container.textContent).toContain("3 times");
    expect(container.textContent).not.toContain("priority 500");
  });

  it("does not advertise or seed wildcard action selectors", async () => {
    await render([]);

    expect(container.textContent).toContain("Ask first before selected actions");
    expect(container.textContent).not.toContain("Wildcard action names");
    expect(container.textContent).not.toContain("*send*");
    expect(container.textContent).not.toContain("*delete*");

    const starter = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Ask first before selected actions")
    );
    flushSync(() => starter?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();

    expect(container.querySelector("#tool-patterns")).toBeNull();
    expect([...container.querySelectorAll("input")].map((input) => input.value).join(" ")).not.toContain("*");
  });

  it("wires duplicate, toggle, delete, and reorder actions to the Rules endpoints", async () => {
    await render([
      policy({ id: "rule-1", policyType: "block", selectors: { toolName: "gmail.delete" } }),
      policy({ id: "rule-2", policyType: "allow", selectors: { applicationId: "app-gmail" }, priority: 200 }),
    ]);

    const duplicateButton = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Duplicate"));
    flushSync(() => duplicateButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(toolsApiMock.duplicatePolicy).toHaveBeenCalledWith("company-1", "rule-1");

    const firstSwitch = container.querySelector<HTMLButtonElement>('[role="switch"]');
    flushSync(() => firstSwitch?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(toolsApiMock.updatePolicy).toHaveBeenCalledWith("company-1", "rule-1", { enabled: false });

    const rows = container.querySelectorAll("tbody tr");
    flushSync(() => {
      rows[0]?.dispatchEvent(new Event("dragstart", { bubbles: true }));
      rows[1]?.dispatchEvent(new Event("drop", { bubbles: true }));
    });
    await flushReact();
    expect(toolsApiMock.reorderPolicies).toHaveBeenCalledWith("company-1", { policyIds: ["rule-2", "rule-1"] });

    const deleteButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Delete") && button.className.includes("text-destructive")
    );
    flushSync(() => deleteButton?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(container.textContent).toContain("matched 3 times in the last 24 hours");

    const confirmDelete = [...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("Delete")).at(-1);
    flushSync(() => confirmDelete?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(toolsApiMock.deletePolicy).toHaveBeenCalledWith("company-1", "rule-1");
  });

  it("shows remembered approvals with Forget confirmation", async () => {
    toolsApiMock.listTrustRules.mockResolvedValue({
      trustRules: [
        policy({
          id: "trust-1",
          policyType: "trust_rule",
          selectors: { agentId: "agent-1", toolName: "gmail.send" },
        }),
      ],
    });
    await render([]);

    expect(container.textContent).toContain("Remembered approvals");
    expect(container.textContent).toContain("When Fable uses Send email -> Allow");

    const forget = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("Forget"));
    flushSync(() => forget?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(container.textContent).toContain("Paperclip will ask again");

    const confirmForget = [...container.querySelectorAll("button")].filter((button) => button.textContent?.includes("Forget")).at(-1);
    flushSync(() => confirmForget?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await flushReact();
    expect(toolsApiMock.revokeTrustRule).toHaveBeenCalledWith("company-1", "trust-1");
  });
});
