// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { CompanyProvider, useCompany } from "@/context/CompanyContext";
import { InstanceAccess } from "./InstanceAccess";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), directory: vi.fn(), detachInflightList: vi.fn(), detachInflightDirectory: vi.fn(),
  getSession: vi.fn(), searchAdminUsers: vi.fn(), getUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(), setBreadcrumbs: vi.fn(), pushToast: vi.fn(),
  disableUser: vi.fn(), enableUser: vi.fn(), deleteUser: vi.fn(), demoteInstanceAdmin: vi.fn(),
}));
vi.mock("@/api/companies", () => ({ companiesApi: mocks }));
vi.mock("@/api/auth", () => ({ authApi: mocks }));
vi.mock("@/api/access", () => ({ accessApi: mocks }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => mocks }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => mocks }));

const companyA = { id: "company-a", name: "Company A", issuePrefix: "CPA", status: "active" };
const companyB = { id: "company-b", name: "Company B", issuePrefix: "CPB", status: "active" };
const user = {
  id: "admin", name: "Admin", email: "admin@example.com", isInstanceAdmin: true,
  status: "active", disabledAt: null, disabledByUserId: null, disabledReason: null,
};
const member = {
  ...user, id: "member", name: "Member", email: "member@example.com", isInstanceAdmin: false,
};
const membershipA = {
  id: "membership-a", companyId: companyA.id, companyName: companyA.name,
  status: "active", membershipRole: "owner", updatedAt: "2020-01-01T00:00:00Z",
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

function NavigationProbe() {
  const { companies } = useCompany();
  return <nav data-testid="navigation">{companies.map((company) => company.name).join(", ")}</nav>;
}

async function renderPage() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CompanyProvider><NavigationProbe /><InstanceAccess /></CompanyProvider>
      </QueryClientProvider>,
    );
  });
}

async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertion();
  });
}

function button(text: string) {
  return [...container.querySelectorAll("button")].find((element) => element.textContent === text);
}

// Alert dialogs render into a portal on document.body.
function dialogButton(text: string) {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')]
    .find((element) => element.textContent === text);
}

async function selectMember() {
  await eventually(() => expect(container.textContent).toContain("Member"));
  const entry = [...container.querySelectorAll("button")].find((element) =>
    element.textContent?.includes("member@example.com"));
  await act(async () => entry!.click());
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  mocks.getSession.mockResolvedValue({ session: { id: "session-admin", userId: user.id }, user });
  mocks.list.mockResolvedValue([companyA]);
  mocks.directory.mockResolvedValue([companyA, companyB]);
  mocks.searchAdminUsers.mockResolvedValue([user]);
  mocks.getUserCompanyAccess.mockResolvedValue({ user, companyAccess: [membershipA] });
  mocks.setUserCompanyAccess.mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

describe("InstanceAccess company directory", () => {
  it("lets admins grant access outside their navigation list and refreshes their own navigation", async () => {
    await renderPage();
    await eventually(() => {
      expect(button("Save organization access")).toBeDefined();
      expect(container.querySelector("nav")?.textContent).toBe("Company A");
    });
    const otherCompany = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("Company B"));
    const checkbox = otherCompany?.querySelector<HTMLButtonElement>('[role="checkbox"]');
    expect(checkbox?.getAttribute("aria-checked")).toBe("false");
    mocks.setUserCompanyAccess.mockImplementation(async () => {
      mocks.list.mockResolvedValue([companyA, companyB]);
      mocks.getUserCompanyAccess.mockResolvedValue({ user, companyAccess: [membershipA, {
        ...membershipA, id: "membership-b", companyId: companyB.id, companyName: companyB.name,
      }] });
      return {};
    });
    await act(async () => checkbox!.click());
    await act(async () => button("Save organization access")!.click());
    await eventually(() => {
      expect(mocks.setUserCompanyAccess).toHaveBeenCalledWith(user.id, [companyA.id, companyB.id]);
      expect(container.querySelector("nav")?.textContent).toBe("Company A, Company B");
    });
  });

  it("prevents editing an incomplete directory and lets the admin retry", async () => {
    mocks.directory.mockRejectedValue(new Error("Unavailable"));
    await renderPage();
    await eventually(() => {
      expect(container.textContent).toContain("Failed to load organizations.");
      expect(container.querySelector("nav")?.textContent).toBe("Company A");
    });
    expect(button("Save organization access")).toBeUndefined();
    expect(mocks.setUserCompanyAccess).not.toHaveBeenCalled();
    mocks.directory.mockResolvedValue([companyA, companyB]);
    await act(async () => button("Try again")!.click());
    await eventually(() => expect(button("Save organization access")).toBeDefined());
  });

  it("does not request the directory when instance administration is forbidden", async () => {
    mocks.searchAdminUsers.mockRejectedValue(new ApiError("Forbidden", 403, {}));
    await renderPage();
    await eventually(() => expect(container.textContent).toContain("Instance admin access is required"));
    expect(mocks.directory).not.toHaveBeenCalled();
  });
});

describe("InstanceAccess account actions", () => {
  it("does not offer disable or delete for the signed-in admin's own account", async () => {
    await renderPage();
    await eventually(() => expect(button("Save organization access")).toBeDefined());
    expect(button("Disable user")).toBeUndefined();
    expect(button("Delete user")).toBeUndefined();
  });

  it("disables another user with a reason after confirmation", async () => {
    mocks.searchAdminUsers.mockResolvedValue([user, member]);
    mocks.disableUser.mockResolvedValue({ userId: member.id, status: "disabled" });
    await renderPage();
    await selectMember();
    await eventually(() => expect(button("Disable user")).toBeDefined());

    await act(async () => button("Disable user")!.click());
    await eventually(() => expect(dialogButton("Disable user")).toBeDefined());
    expect(mocks.disableUser).not.toHaveBeenCalled();
    const reason = document.querySelector<HTMLTextAreaElement>('[role="alertdialog"] textarea')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setValue.call(reason, "Spam sign-ups");
      reason.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => dialogButton("Disable user")!.click());
    await eventually(() => expect(mocks.disableUser).toHaveBeenCalledWith(member.id, "Spam sign-ups"));
    expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "User disabled" }));
  });

  it("shows a disabled user's status and re-enables them", async () => {
    mocks.searchAdminUsers.mockResolvedValue([user, {
      ...member, status: "disabled", disabledAt: "2026-01-02T00:00:00Z", disabledReason: "Left the team",
    }]);
    mocks.enableUser.mockResolvedValue({ userId: member.id, status: "active", wasDisabled: true });
    await renderPage();
    await selectMember();
    await eventually(() => {
      expect(button("Enable user")).toBeDefined();
      expect(container.textContent).toContain("Reason: Left the team");
    });
    expect(button("Disable user")).toBeUndefined();
    await act(async () => button("Enable user")!.click());
    await eventually(() => expect(mocks.enableUser).toHaveBeenCalledWith(member.id));
  });

  it("surfaces the server's refusal to remove the last instance admin", async () => {
    mocks.demoteInstanceAdmin.mockRejectedValue(new ApiError(
      "Cannot remove the last active instance admin",
      409,
      { code: "instance_user_last_admin" },
    ));
    await renderPage();
    await eventually(() => expect(button("Remove instance admin")).toBeDefined());
    await act(async () => button("Remove instance admin")!.click());
    await eventually(() => expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Could not update instance role",
      body: "Cannot remove the last active instance admin",
      tone: "error",
    })));
    expect(mocks.demoteInstanceAdmin).toHaveBeenCalledWith(user.id);
    expect(button("Remove instance admin")!.disabled).toBe(false);
  });

  it("surfaces the server's refusal to delete a user with history", async () => {
    mocks.searchAdminUsers.mockResolvedValue([user, member]);
    mocks.deleteUser.mockRejectedValue(new ApiError(
      "This user has organization history and cannot be deleted. Disable the account instead.",
      409,
      { code: "instance_user_has_history" },
    ));
    await renderPage();
    await selectMember();
    await eventually(() => expect(button("Delete user")).toBeDefined());
    await act(async () => button("Delete user")!.click());
    await eventually(() => expect(dialogButton("Delete user")).toBeDefined());
    await act(async () => dialogButton("Delete user")!.click());
    await eventually(() => expect(mocks.pushToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Could not delete user",
      body: expect.stringContaining("Disable the account instead"),
      tone: "error",
    })));
    expect(mocks.deleteUser).toHaveBeenCalledWith(member.id);
  });
});
