// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyAccess, CompanyAccessLegacyRoute } from "./CompanyAccess";

const listMembersMock = vi.hoisted(() => vi.fn());
const listJoinRequestsMock = vi.hoisted(() => vi.fn());
const updateMemberMock = vi.hoisted(() => vi.fn());
const archiveMemberMock = vi.hoisted(() => vi.fn());
const listAgentsMock = vi.hoisted(() => vi.fn());
const listIssuesMock = vi.hoisted(() => vi.fn());
const mockUsePluginSlots = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listMembers: (companyId: string) => listMembersMock(companyId),
    listJoinRequests: (companyId: string, status: string) => listJoinRequestsMock(companyId, status),
    updateMember: (companyId: string, memberId: string, input: unknown) =>
      updateMemberMock(companyId, memberId, input),
    updateMemberPermissions: vi.fn(),
    updateMemberAccess: vi.fn(),
    archiveMember: (companyId: string, memberId: string, input: unknown) =>
      archiveMemberMock(companyId, memberId, input),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
  },
}));

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (companyId: string) => listAgentsMock(companyId),
  },
}));

vi.mock("@/api/issues", () => ({
  issuesApi: {
    list: (companyId: string, filters: unknown) => listIssuesMock(companyId, filters),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: ({ to, replace }: { to: string; replace?: boolean }) => {
    mockNavigate(to, replace);
    return <div data-testid="navigate">{to}</div>;
  },
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: mockUsePluginSlots,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip" },
  }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("@/context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("CompanyAccess", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listMembersMock.mockResolvedValue({
      members: [
        {
          id: "member-1",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-1",
          status: "active",
          membershipRole: "owner",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "user-1",
            email: "codexcoder@paperclip.local",
            name: "Codex Coder",
            image: null,
          },
          grants: [],
        },
        {
          id: "member-2",
          companyId: "company-1",
          principalType: "user",
          principalId: "user-2",
          status: "active",
          membershipRole: "operator",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "user-2",
            email: "board@paperclip.local",
            name: "Board User",
            image: null,
          },
          grants: [],
        },
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: true,
      },
    });
    listJoinRequestsMock.mockResolvedValue([
      {
        id: "join-1",
        requestType: "human",
        createdAt: "2026-04-10T00:00:00.000Z",
        requesterUser: {
          id: "user-2",
          email: "board@paperclip.local",
          name: "Board User",
          image: null,
        },
        requestEmailSnapshot: "board@paperclip.local",
        requestingUserId: "user-2",
        invite: {
          allowedJoinTypes: "human",
          humanRole: "operator",
        },
      },
      {
        id: "join-2",
        requestType: "agent",
        createdAt: "2026-04-10T00:00:00.000Z",
        agentName: "Codex Worker",
        adapterType: "codex_local",
        capabilities: "Implements code changes",
        invite: {
          allowedJoinTypes: "agent",
          humanRole: null,
        },
      },
    ]);
    updateMemberMock.mockResolvedValue({});
    archiveMemberMock.mockResolvedValue({ reassignedIssueCount: 1 });
    listAgentsMock.mockResolvedValue([
      {
        id: "agent-1",
        name: "Codex Worker",
        role: "engineer",
        status: "active",
      },
    ]);
    listIssuesMock.mockResolvedValue([
      {
        id: "issue-1",
        identifier: "PAP-1",
        title: "Assigned to removed user",
        status: "todo",
      },
    ]);
    mockUsePluginSlots.mockReturnValue({
      slots: [],
      isLoading: false,
      errorMessage: null,
    });
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps the page human-focused and hides advanced permission controls", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Manage the people who can work in Paperclip");
    expect(container.textContent).toContain("Members can collaborate across the company by default");
    expect(container.textContent).toContain("Core keeps this page focused on membership");
    expect(container.textContent).toContain("Humans");
    expect(container.textContent).toContain("Pending human joins");
    expect(container.textContent).toContain("User account");
    expect(container.textContent).not.toContain("Grants");
    expect(container.textContent).not.toContain("explicit grants");
    expect(container.textContent).not.toContain("Assign scoped tasks");
    expect(container.textContent).not.toContain("Agents");
    expect(container.textContent).not.toContain("Pending agent joins");
    expect(container.textContent).not.toContain("Open join request queue");
    expect(container.textContent).not.toContain("Manage invites");
    expect(container.textContent).not.toContain("Active user accounts");
    expect(container.textContent).not.toContain("Suspended user accounts");
    expect(container.textContent).not.toContain("Pending user joins");

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Update company role and membership status");
    expect(document.body.textContent).not.toContain("Implicit grants from role");
    expect(document.body.textContent).not.toContain("permissionKey");

    await act(async () => {
      root.unmount();
    });
  });

  it("saves member role and status without touching grants", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const editButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Edit",
    );
    expect(editButton).toBeTruthy();

    await act(async () => {
      editButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    const saveButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Save member",
    );
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(updateMemberMock).toHaveBeenCalledWith("company-1", "member-1", {
      membershipRole: "owner",
      status: "active",
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("removes a member with an issue reassignment target", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    const removeButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent?.includes("Remove"),
    );
    expect(removeButtons.length).toBeGreaterThan(0);

    await act(async () => {
      removeButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(document.body.textContent).toContain("Remove member");
    expect(document.body.textContent).toContain("Assigned to removed user");

    const reassignmentSelect = document.body.querySelector("select");
    expect(reassignmentSelect).toBeTruthy();
    await act(async () => {
      reassignmentSelect!.value = "user:user-2";
      reassignmentSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const confirmButton = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Remove member",
    );
    expect(confirmButton).toBeTruthy();

    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(archiveMemberMock).toHaveBeenCalledWith("company-1", "member-1", {
      reassignment: { assigneeAgentId: null, assigneeUserId: "user-2" },
    });

    await act(async () => {
      root.unmount();
    });
  });

  it("shows protected member removal reasons from the API", async () => {
    listMembersMock.mockResolvedValueOnce({
      members: [
        {
          id: "member-admin",
          companyId: "company-1",
          principalType: "user",
          principalId: "admin-user",
          status: "active",
          membershipRole: "admin",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
          user: {
            id: "admin-user",
            email: "admin@paperclip.local",
            name: "Admin User",
            image: null,
          },
          grants: [],
          removal: {
            canArchive: false,
            reason: "Company admins cannot be removed from company access.",
          },
        },
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: false,
      },
    });

    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccess />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Company admins cannot be removed from company access.");
    const removeButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Remove"),
    );
    expect(removeButton).toBeTruthy();
    expect(removeButton).toHaveProperty("disabled", true);

    await act(async () => {
      root.unmount();
    });
  });

  it("redirects legacy access deep links to the permissions extension route when installed", async () => {
    mockUsePluginSlots.mockReturnValue({
      slots: [
        {
          type: "companySettingsPage",
          id: "permissions",
          displayName: "Permissions",
          routePath: "permissions",
          pluginKey: "permissions-extension",
        },
      ],
      isLoading: false,
      errorMessage: null,
    });
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccessLegacyRoute />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(mockNavigate).toHaveBeenCalledWith("/company/settings/permissions", true);
    expect(container.textContent).toContain("/company/settings/permissions");

    await act(async () => {
      root.unmount();
    });
  });

  it("shows a read-only unavailable fallback for legacy access deep links", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <CompanyAccessLegacyRoute />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Advanced Permissions");
    expect(container.textContent).toContain("Advanced permissions unavailable");
    expect(container.textContent).toContain("Open Members");
    expect(container.textContent).toContain("Open Invites");

    await act(async () => {
      root.unmount();
    });
  });
});
