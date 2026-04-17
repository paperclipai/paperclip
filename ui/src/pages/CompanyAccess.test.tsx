// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyAccess } from "./CompanyAccess";

const listMembersMock = vi.hoisted(() => vi.fn());
const listJoinRequestsMock = vi.hoisted(() => vi.fn());
const updateMemberAccessMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/access", () => ({
  accessApi: {
    listMembers: (companyId: string) => listMembersMock(companyId),
    listJoinRequests: (companyId: string, status: string) => listJoinRequestsMock(companyId, status),
    updateMember: vi.fn(),
    updateMemberPermissions: vi.fn(),
    updateMemberAccess: (companyId: string, memberId: string, input: unknown) =>
      updateMemberAccessMock(companyId, memberId, input),
    approveJoinRequest: vi.fn(),
    rejectJoinRequest: vi.fn(),
  },
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
    updateMemberAccessMock.mockResolvedValue({});
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("keeps the page human-focused and explains implicit versus explicit grants", async () => {
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

    expect(container.textContent).toContain("Manage company user memberships");
    expect(container.textContent).toContain("Humans");
    expect(container.textContent).toContain("Pending human joins");
    expect(container.textContent).toContain("User account");
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

    expect(document.body.textContent).toContain("Implicit grants from role");
    expect(document.body.textContent).toContain("Owner currently includes these permissions automatically.");
    expect(document.body.textContent).toContain(
      "Included implicitly by the Owner role. Add an explicit grant only if it should stay after the role changes.",
    );

    await act(async () => {
      root.unmount();
    });
  });

  it("saves member role, status, and grants in one request", async () => {
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
      (button) => button.textContent === "Save access",
    );
    expect(saveButton).toBeTruthy();

    await act(async () => {
      saveButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flushReact();

    expect(updateMemberAccessMock).toHaveBeenCalledWith("company-1", "member-1", {
      membershipRole: "owner",
      status: "active",
      grants: [],
    });

    await act(async () => {
      root.unmount();
    });
  });
});
