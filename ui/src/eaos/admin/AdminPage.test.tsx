// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Letsmake", issuePrefix: "LET", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const listMembersMock = vi.fn();

vi.mock("@/api/access", () => ({
  accessApi: {
    listMembers: (companyId: string) => listMembersMock(companyId),
  },
}));

import { AdminPage } from "./AdminPage";

function makeMember(overrides: Partial<{
  id: string;
  status: string;
  membershipRole: string | null;
  user: { id: string; name?: string | null; email?: string | null; slug?: string | null } | null;
  grants: unknown[];
}>) {
  return {
    id: overrides.id ?? "member-1",
    status: overrides.status ?? "active",
    membershipRole: overrides.membershipRole ?? "viewer",
    user: overrides.user ?? null,
    grants: overrides.grants ?? [],
    principalType: "user",
  };
}

let container: HTMLDivElement | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  listMembersMock.mockReset();
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
  queryClient.clear();
});

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForMicrotaskAssertion(assertion: () => void, attempts = 30) {
  let lastError: unknown;
  for (let index = 0; index < attempts; index += 1) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function renderAdmin() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/eaos/admin"]}>
          <Routes>
            <Route path="/eaos/admin" element={<AdminPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return root;
}

describe("AdminPage (LET-484 working-product slice)", () => {
  it("renders the admin surface (not the EaosZonePlaceholder)", async () => {
    listMembersMock.mockResolvedValue({
      members: [],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: true,
      },
    });
    await renderAdmin();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-admin-page"]')).not.toBeNull();
    });
    expect(container?.querySelector('[data-testid="eaos-zone-placeholder"]')).toBeNull();
  });

  it("labels members backend-backed and surfaces APPROVAL REQUIRED for mutations", async () => {
    listMembersMock.mockResolvedValue({
      members: [makeMember({ id: "m-1", membershipRole: "owner" })],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: true,
      },
    });
    await renderAdmin();
    await waitForMicrotaskAssertion(() => {
      const posture = container?.querySelector('[data-testid="eaos-admin-posture"]');
      const text = posture?.textContent ?? "";
      expect(text).toContain("Shell · BACKEND-BACKED");
      expect(text).toContain("Members · BACKEND-BACKED");
      expect(text).toContain("Mutations · APPROVAL REQUIRED");
    });
  });

  it("renders the access posture and member roster with backend counts", async () => {
    listMembersMock.mockResolvedValue({
      members: [
        makeMember({ id: "owner-1", membershipRole: "owner", user: { id: "u-1", name: "Andrii" } }),
        makeMember({ id: "admin-1", membershipRole: "admin", user: { id: "u-2", name: "Reviewer" } }),
        makeMember({
          id: "operator-1",
          membershipRole: "operator",
          status: "pending",
          user: { id: "u-3", name: "Operator" },
        }),
      ],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: true,
      },
    });
    await renderAdmin();
    await waitForMicrotaskAssertion(() => {
      expect(
        container?.querySelector('[data-testid="eaos-admin-access-role"]')?.textContent,
      ).toContain("owner");
      expect(
        container?.querySelector('[data-testid="eaos-admin-access-can-manage"]')?.textContent,
      ).toContain("Yes");
      expect(container?.querySelector('[data-testid="eaos-admin-summary-total"]')?.textContent).toContain("3");
      expect(container?.querySelector('[data-testid="eaos-admin-summary-owners"]')?.textContent).toContain("1");
      expect(container?.querySelector('[data-testid="eaos-admin-summary-pending"]')?.textContent).toContain("1");

      const rows = container?.querySelectorAll('[data-testid="eaos-admin-member-row"]');
      expect(rows?.length).toBe(3);
    });
  });

  it("names the audit log + secrets gaps as truthful temporary gaps", async () => {
    listMembersMock.mockResolvedValue({
      members: [],
      access: {
        currentUserRole: "viewer",
        canManageMembers: false,
        canInviteUsers: false,
        canApproveJoinRequests: false,
      },
    });
    await renderAdmin();
    await waitForMicrotaskAssertion(() => {
      const audit = container?.querySelector('[data-testid="eaos-admin-audit-pointer"]');
      expect(audit?.textContent).toContain("Backend path pending");
      expect(audit?.textContent).toContain("/api/companies/:companyId/audit-log");
      const auditLink = container?.querySelector('[data-testid="eaos-admin-audit-runs-link"]');
      expect(auditLink?.getAttribute("href")).toBe("/eaos/runs");

      const secrets = container?.querySelector('[data-testid="eaos-admin-secrets-pointer"]');
      expect(secrets?.textContent).toContain("never renders raw secrets");
    });
  });

  it("does NOT render any live action buttons", async () => {
    listMembersMock.mockResolvedValue({
      members: [makeMember({ id: "m-1" })],
      access: {
        currentUserRole: "owner",
        canManageMembers: true,
        canInviteUsers: true,
        canApproveJoinRequests: true,
      },
    });
    await renderAdmin();
    await waitForMicrotaskAssertion(() => {
      expect(container?.querySelector('[data-testid="eaos-admin-member-row"]')).not.toBeNull();
    });
    expect(container?.querySelectorAll("button").length).toBe(0);
  });
});
