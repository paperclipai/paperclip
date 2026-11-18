// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPersonaSwitcher } from "./DashboardPersonaSwitcher";

const mocks = vi.hoisted(() => ({
  company: { companies: [] as unknown[], selectedCompanyId: null as string | null, setSelectedCompanyId: vi.fn() },
  navigate: vi.fn(),
}));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => mocks.company }));
vi.mock("@/lib/router", () => ({ useNavigate: () => mocks.navigate }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const org = (id: string, prefix: string, description: string, createdAt: string) =>
  ({ id, issuePrefix: prefix, description, createdAt: new Date(createdAt), status: "active" });
const scott = org("co-scott", "SCO", "[dashboard-demo] Scott — Chief Product Officer", "2026-11-01");
const dotta = org("co-dotta", "DOT", "[dashboard-demo] Dotta — CEO and engineer", "2026-11-02");
const tom = org("co-tom", "TOM", "[dashboard-demo] Tom — Investor", "2026-11-03");
const demoCo = org("co-demo", "DEM", "Demo Co", "2026-01-01");

let root: Root;
let host: HTMLDivElement;

async function render() {
  await act(async () => root.render(<DashboardPersonaSwitcher />));
}
const switcher = () => host.querySelector<HTMLElement>("[data-dashboard-persona-switcher]");
const people = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.company.companies = [tom, demoCo, scott, dotta];
  mocks.company.selectedCompanyId = scott.id;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("DashboardPersonaSwitcher", () => {
  it("shows every demo person at once, in the order they were created, with the current one chosen", async () => {
    await render();
    expect(people().map((person) => [person.textContent, person.getAttribute("aria-checked")])).toEqual([
      ["SScott, Chief Product Officer", "true"],
      ["DDotta, CEO and engineer", "false"],
      ["TTom, Investor", "false"],
    ]);
    // The chosen person's role is spelled out beside the toggle.
    expect(switcher()?.textContent).toContain("Chief Product Officer");
  });

  it("goes to the chosen person's Dashboard the way the organization menu does", async () => {
    await render();
    await act(async () => people()[2]!.click());
    expect(mocks.company.setSelectedCompanyId).toHaveBeenCalledExactlyOnceWith("co-tom");
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith("/TOM/responsibilities");
  });

  it("does nothing when the current person is chosen again", async () => {
    await render();
    await act(async () => people()[0]!.click());
    expect(mocks.company.setSelectedCompanyId).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("shows from an organization outside the demo, with nobody chosen", async () => {
    mocks.company.selectedCompanyId = demoCo.id;
    await render();
    expect(people()).toHaveLength(3);
    expect(people().every((person) => person.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("is absent with fewer than two demo organizations", async () => {
    mocks.company.companies = [scott, demoCo];
    await render();
    expect(switcher()).toBeNull();
  });
});
