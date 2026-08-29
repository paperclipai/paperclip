// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PermissionKey } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrincipalGrantsEditor } from "./PrincipalGrantsEditor";

const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));
const mockAgentsApi = vi.hoisted(() => ({
  updateGrants: vi.fn(),
}));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));
vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));
vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

const companyId = "company-1";
const agentId = "agent-1";

function membersAccess(canManageAgentGrants: boolean) {
  return {
    members: [],
    access: {
      currentUserRole: "owner" as const,
      canManageMembers: canManageAgentGrants,
      canInviteUsers: true,
      canApproveJoinRequests: true,
      canManageAgentGrants,
    },
  };
}

describe("PrincipalGrantsEditor", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    mockAccessApi.listMembers.mockResolvedValue(membersAccess(true));
    mockAgentsApi.updateGrants.mockResolvedValue({});
  });

  afterEach(async () => {
    if (root) {
      const currentRoot = root;
      await act(async () => {
        currentRoot.unmount();
      });
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderEditor(
    currentGrants: Array<{ permissionKey: PermissionKey; scope?: Record<string, unknown> | null }> = [],
  ) {
    const createdRoot = createRoot(container);
    root = createdRoot;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      createdRoot.render(
        <QueryClientProvider client={queryClient}>
          <PrincipalGrantsEditor
            companyId={companyId}
            agentId={agentId}
            currentGrants={currentGrants}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    await flushReact();
  }

  function checkbox(permissionKey: string): HTMLButtonElement {
    const labels = Array.from(container.querySelectorAll("label"));
    const match = labels.find((label) => label.textContent?.includes(permissionKey));
    if (!match) throw new Error(`No grant row for ${permissionKey}`);
    const box = match.querySelector<HTMLButtonElement>('[data-slot="checkbox"]');
    if (!box) throw new Error(`No checkbox for ${permissionKey}`);
    return box;
  }

  async function saveButton(): Promise<HTMLButtonElement> {
    const match = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Save grants"),
    );
    if (!match) throw new Error("Save grants button not found");
    return match;
  }

  it("renders current grants as checked and submits the full replacement set", async () => {
    await renderEditor([
      { permissionKey: "tasks:assign", scope: null },
      { permissionKey: "tools:use", scope: { profileId: "p1" } },
    ]);

    expect(checkbox("tasks:assign").getAttribute("data-state")).toBe("checked");
    expect(checkbox("tools:use").getAttribute("data-state")).toBe("checked");
    expect(checkbox("agents:configure").getAttribute("data-state")).toBe("unchecked");
    expect(container.textContent).toContain("scope:");

    await act(async () => {
      checkbox("agents:configure").click();
    });
    await flushReact();

    await act(async () => {
      (await saveButton()).click();
    });
    await flushReact();

    expect(mockAgentsApi.updateGrants).toHaveBeenCalledTimes(1);
    const [calledAgentId, payload, calledCompanyId] = mockAgentsApi.updateGrants.mock.calls[0];
    expect(calledAgentId).toBe(agentId);
    expect(calledCompanyId).toBe(companyId);
    const keys = payload.grants.map((grant: { permissionKey: string }) => grant.permissionKey);
    expect(keys).toContain("tasks:assign");
    expect(keys).toContain("tools:use");
    expect(keys).toContain("agents:configure");
    expect(keys).not.toContain("users:manage_permissions");
    const toolsGrant = payload.grants.find(
      (grant: { permissionKey: string }) => grant.permissionKey === "tools:use",
    );
    expect(toolsGrant.scope).toEqual({ profileId: "p1" });
  });

  it("hides the editor for users without agent-grant management capability", async () => {
    mockAccessApi.listMembers.mockResolvedValue(membersAccess(false));

    await renderEditor();

    expect(container.textContent).toBe("");
    expect(mockAgentsApi.updateGrants).not.toHaveBeenCalled();
  });

  it("shows the escalation warning when users:manage_permissions is selected", async () => {
    await renderEditor();

    expect(container.textContent).not.toContain("rewrite permission grants");

    await act(async () => {
      checkbox("users:manage_permissions").click();
    });
    await flushReact();

    expect(container.textContent).toContain("rewrite permission grants");
  });
});
