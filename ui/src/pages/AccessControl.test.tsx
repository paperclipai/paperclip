// @vitest-environment jsdom

import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessControl } from "./AccessControl";

const listRolesMock = vi.fn();
const listMemberAccessSummaryMock = vi.fn();
const seedSystemRolesMock = vi.fn();
const createRoleMock = vi.fn();
const updateRoleMock = vi.fn();
const archiveRoleMock = vi.fn();
const departmentsListMock = vi.fn();

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: vi.fn() }),
}));

vi.mock("../api/access", () => ({
  accessApi: {
    listRoles: (companyId: string) => listRolesMock(companyId),
    listMemberAccessSummary: (companyId: string) => listMemberAccessSummaryMock(companyId),
    seedSystemRoles: (companyId: string) => seedSystemRolesMock(companyId),
    createRole: (companyId: string, input: unknown) => createRoleMock(companyId, input),
    updateRole: (companyId: string, roleId: string, input: unknown) => updateRoleMock(companyId, roleId, input),
    archiveRole: (companyId: string, roleId: string) => archiveRoleMock(companyId, roleId),
    setMemberPermissions: vi.fn(),
    assignRole: vi.fn(),
    removeRoleAssignment: vi.fn(),
  },
}));

vi.mock("../api/departments", () => ({
  departmentsApi: {
    list: (companyId: string) => departmentsListMock(companyId),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

describe("AccessControl", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    listRolesMock.mockReset();
    listMemberAccessSummaryMock.mockReset();
    seedSystemRolesMock.mockReset();
    createRoleMock.mockReset();
    updateRoleMock.mockReset();
    archiveRoleMock.mockReset();
    departmentsListMock.mockReset();
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders roles and principal access summaries", async () => {
    listRolesMock.mockResolvedValue([
      {
        id: "role-1",
        companyId: "company-1",
        key: "department_manager",
        name: "Department Manager",
        description: "Scoped manager",
        isSystem: true,
        status: "active",
        permissionKeys: ["projects:view", "issues:view"],
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    ]);
    listMemberAccessSummaryMock.mockResolvedValue([
      {
        id: "membership-1",
        companyId: "company-1",
        principalType: "user",
        principalId: "user-1",
        status: "active",
        membershipRole: "member",
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
        principal: {
          id: "user-1",
          type: "user",
          name: "Rita Reviewer",
          email: "rita@example.com",
          title: null,
          status: "active",
          urlKey: null,
        },
        directGrants: [
          {
            id: "grant-1",
            companyId: "company-1",
            principalType: "user",
            principalId: "user-1",
            permissionKey: "tasks:assign",
            scope: null,
            grantedByUserId: "admin-1",
            createdAt: "2026-04-08T00:00:00.000Z",
            updatedAt: "2026-04-08T00:00:00.000Z",
          },
        ],
        roleAssignments: [
          {
            id: "assignment-1",
            companyId: "company-1",
            roleId: "role-1",
            principalType: "user",
            principalId: "user-1",
            scope: {
              kind: "departments",
              departmentIds: ["dept-1"],
              includeDescendants: true,
            },
            assignedByUserId: "admin-1",
            createdAt: "2026-04-08T00:00:00.000Z",
            updatedAt: "2026-04-08T00:00:00.000Z",
            role: {
              id: "role-1",
              companyId: "company-1",
              key: "department_manager",
              name: "Department Manager",
              description: "Scoped manager",
              isSystem: true,
              status: "active",
              permissionKeys: ["projects:view", "issues:view"],
              createdAt: "2026-04-08T00:00:00.000Z",
              updatedAt: "2026-04-08T00:00:00.000Z",
            },
          },
        ],
        effectivePermissions: [
          {
            permissionKey: "projects:view",
            companyWide: false,
            departmentIds: ["dept-1"],
          },
        ],
      },
    ]);
    seedSystemRolesMock.mockResolvedValue([]);
    departmentsListMock.mockResolvedValue([
      {
        id: "dept-1",
        companyId: "company-1",
        name: "Engineering",
        description: null,
        parentId: null,
        status: "active",
        sortOrder: 0,
        createdAt: "2026-04-08T00:00:00.000Z",
        updatedAt: "2026-04-08T00:00:00.000Z",
      },
    ]);

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AccessControl />
        </QueryClientProvider>,
      );
      await flush();
    });

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Access Control");
      expect(container.textContent).toContain("Department Manager");
      expect(container.textContent).toContain("Rita Reviewer");
      expect(container.textContent).toContain("tasks:assign");
      expect(container.textContent).toContain("Engineering + descendants");
      expect(container.textContent).toContain("Permission Matrix");
      expect(container.textContent).toContain("Projects & Issues");
      expect(container.textContent).toContain("projects view");
      expect(container.textContent).toContain("Create Custom Role");
      expect(container.textContent).toContain("Advanced Grants");
    });

    const seedButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Seed System Roles"),
    );
    expect(seedButton).toBeTruthy();

    await act(async () => {
      seedButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    expect(seedSystemRolesMock).toHaveBeenCalledWith("company-1");

    await act(async () => {
      root.unmount();
    });
  });

  it("groups permissions by category in the custom role dialog", async () => {
    listRolesMock.mockResolvedValue([]);
    listMemberAccessSummaryMock.mockResolvedValue([]);
    seedSystemRolesMock.mockResolvedValue([]);
    departmentsListMock.mockResolvedValue([]);

    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AccessControl />
        </QueryClientProvider>,
      );
      await flush();
    });

    const createRoleButton = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Create Custom Role"),
    );
    expect(createRoleButton).toBeTruthy();

    await act(async () => {
      createRoleButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flush();
    });

    await waitForAssertion(() => {
      expect(document.body.textContent).toContain("Create custom role");
      expect(document.body.textContent).toContain("Organization & Access");
      expect(document.body.textContent).toContain("Departments & Teams");
      expect(document.body.textContent).toContain("Projects & Issues");
      expect(document.body.textContent).toContain("Agents & Operations");
      expect(document.body.textContent).toContain("roles manage");
      expect(document.body.textContent).toContain("tasks assign scope");
    });

    await act(async () => {
      root.unmount();
    });
  });
});
