// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyMember, CurrentBoardAccess } from "@/api/access";
import { GitHubSponsorSelect } from "./GitHubSponsorSelect";

const members = [
  { principalId: "self", companyId: "company", status: "active", membershipRole: "operator", user: { name: "My Name", image: "https://example.com/self.png" } },
  { principalId: "other", companyId: "company", status: "active", membershipRole: "operator", user: { name: "Other Person", image: "https://example.com/other.png" } },
  { principalId: "viewer", companyId: "company", status: "active", membershipRole: "viewer", user: { name: "Viewer" } },
  { principalId: "suspended", companyId: "company", status: "suspended", membershipRole: "admin", user: { name: "Suspended" } },
] as CompanyMember[];
const access = (role = "operator", overrides = {}): CurrentBoardAccess => ({
  user: null, userId: "self", source: "session", isInstanceAdmin: false, companyIds: ["company"], keyId: null,
  memberships: [{ companyId: "company", status: "active", membershipRole: role as "operator" }],
  ...overrides,
});

describe("GitHub sponsor picker", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onChange = vi.fn();
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    onChange.mockClear();
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function render(boardAccess: CurrentBoardAccess | undefined = access(), value = "self") {
    await act(async () => root.render(<GitHubSponsorSelect companyId="company" members={members}
      access={boardAccess} value={value} onChange={onChange} label="Sponsor" />));
  }
  async function open() {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Sponsor"]')!.click());
  }
  const options = () => [...document.querySelectorAll('[role="option"]')];

  it("offers only self to an ordinary connection manager", async () => {
    await render(); await open();
    expect(options().map((item) => item.textContent)).toEqual([expect.stringContaining("My Name")]);
    await act(async () => (options()[0] as HTMLElement).click());
    expect(onChange).toHaveBeenCalledWith("self", expect.objectContaining({ value: "self" }));
  });
  it.each(["owner", "admin", "instance_admin"])("offers active non-viewers to %s", async (role) => {
    await render(access(role, { isInstanceAdmin: role === "instance_admin" }));
    await open();
    expect(options()).toHaveLength(2);
    expect(options()[1].textContent).toContain("Other Person");
    expect(options()[1].querySelector('[data-slot="avatar"]')).not.toBeNull();
  });
  it("keeps an existing other sponsor visible without offering them as a choice", async () => {
    await render(access(), "other");
    expect(container.textContent).toContain("Other Person");
    expect(container.querySelector('[data-slot="avatar"]')).not.toBeNull();
    await open();
    expect(options()).toHaveLength(1);
    expect(options()[0].textContent).toContain("My Name");
  });
  it("does not use an admin role from a different company", async () => {
    await render(access("operator", { memberships: [{ companyId: "elsewhere", status: "active", membershipRole: "admin" }] }));
    await open(); expect(options()).toHaveLength(1);
  });
  it("keeps sponsor filtering linear for a large company", async () => {
    const count = 600;
    let identityReads = 0;
    const largeMembers = Array.from({ length: count }, (_, index) => ({
      ...members[0],
      get principalId() {
        if (++identityReads > count * 4) throw new Error("Repeated member scans");
        return index === 0 ? "self" : `member-${index}`;
      },
      user: { id: `member-${index}`, name: `Member ${index}`, email: null, image: null },
    }));
    await act(async () => root.render(<GitHubSponsorSelect companyId="company" members={largeMembers}
      access={access("admin")} value="self" onChange={onChange} label="Sponsor" />));
    await open();
    expect(options()).toHaveLength(count);
    expect(identityReads).toBeLessThanOrEqual(count * 4);
  });
  it("disables the picker until access is known", async () => {
    await act(async () => root.render(<GitHubSponsorSelect companyId="company" members={members}
      access={undefined} value="self" onChange={onChange} label="Sponsor" />));
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Sponsor"]')!.disabled).toBe(true);
  });
});
