// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardChangesFixture } from "../../../storybook/fixtures/responsibility-dashboard";
import { DashboardChangesCard } from "./DashboardChangesCard";

const acceptMock = vi.hoisted(() => vi.fn());
const declineMock = vi.hoisted(() => vi.fn());
const addCommentMock = vi.hoisted(() => vi.fn());
const getAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/api/responsibility-dashboard", () => ({
  responsibilityDashboardApi: {
    accept: (...args: unknown[]) => acceptMock(...args),
    decline: (...args: unknown[]) => declineMock(...args),
  },
}));
vi.mock("@/api/issues", () => ({ issuesApi: { addComment: (...args: unknown[]) => addCommentMock(...args) } }));
vi.mock("@/api/agents", () => ({ agentsApi: { get: (...args: unknown[]) => getAgentMock(...args) } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DashboardChangesCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    getAgentMock.mockResolvedValue({ id: "agent-dashboard-guide", name: "Chief" });
    acceptMock.mockReset();
    declineMock.mockReset();
    addCommentMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(node: ReactNode) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }

  const button = (label: string, within: ParentNode = container) => {
    const match = [...within.querySelectorAll("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label);
    if (!match) throw new Error(`No button ${label}`);
    return match;
  };
  const group = (name: string) => container.querySelector<HTMLElement>(`section[aria-label="${name}"]`)!;
  const rows = (name: string) => [...group(name).querySelectorAll<HTMLElement>("li")];

  it("shows a first dashboard grouped by area, in plain words, with the agent's reasons", async () => {
    await render(<DashboardChangesCard interaction={dashboardChangesFixture("create")} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Chief proposes");
    expect(text).toContain("A first dashboard from your answers and your calendar.");
    expect([...container.querySelectorAll("h4")].map((heading) => heading.textContent)).toEqual(["Fundraising", "Portfolio", "Team", "Board"]);
    expect(rows("Fundraising").map((row) => row.getAttribute("data-dashboard-change"))).toEqual(["add_area", "add_responsibility", "add_responsibility"]);
    expect(rows("Fundraising")[1]!.textContent).toContain("You run the weekly fundraising sync");
    expect(text).not.toMatch(/\b(issue|interaction|op|areaRef)\b/i);
    expect([...container.querySelectorAll("article > div:last-child button")].map((node) => node.textContent?.trim())).toEqual(["Not right", "Apply changes"]);
  });

  it("reads an edit as a before and after", async () => {
    await render(<DashboardChangesCard interaction={dashboardChangesFixture("edit")} />);
    const reword = rows("Fundraising")[0]!;
    const [before, after] = [...reword.querySelectorAll("p")];
    expect(before!.textContent).toBe("LPs hear from us often.");
    expect(before!.className).toContain("line-through");
    expect(after!.textContent).toBe("Every prospective LP hears from us at least every two weeks.");
    expect(rows("Portfolio")[0]!.textContent).toContain("Moved from Fundraising");
    const team = rows("Team");
    // Area changes first: the rename, seen by others too, then the responsibility let go with its reason.
    expect(team[0]!.textContent).toContain("TeamPeopleAlso renamed for 2 other people");
    expect(team[1]!.textContent).toContain("Hire a second designer.Let goThat is a task that finishes");
  });

  it("drops a new area together with what is filed under it, and keeps the area when one of them is kept", async () => {
    await render(<DashboardChangesCard interaction={dashboardChangesFixture("create")} />);
    await act(async () => button("Drop this change", rows("Portfolio")[0]!).click());
    expect(rows("Portfolio").map((row) => row.hasAttribute("data-dropped"))).toEqual([true, true, true]);
    expect(rows("Portfolio")[1]!.textContent).toContain("Goes with Portfolio");
    expect(rows("Portfolio")[0]!.textContent).not.toContain("Goes with");
    await act(async () => button("Keep", rows("Portfolio")[2]!).click());
    expect(rows("Portfolio").map((row) => row.hasAttribute("data-dropped"))).toEqual([false, true, false]);
    acceptMock.mockResolvedValue({ interaction: dashboardChangesFixture("create", { status: "accepted", result: { version: 1, outcome: "accepted", summary: "Added 4 areas and 5 responsibilities" } }), version: {} });
    await act(async () => button("Apply changes").click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(acceptMock).toHaveBeenCalledExactlyOnceWith("issue-dashboard-conversation", "dashboard-changes-create", [0, 1, 2, 3, 5, 6, 7, 8, 9]);
  });

  it("applies everything when nothing is dropped, and cannot apply nothing", async () => {
    await render(<DashboardChangesCard interaction={dashboardChangesFixture("edit")} />);
    for (const name of ["Fundraising", "Portfolio", "Team"]) {
      for (const row of rows(name)) if (!row.hasAttribute("data-dropped")) await act(async () => button("Drop this change", row).click());
    }
    expect(button("Apply changes").disabled).toBe(true);
    for (const name of ["Fundraising", "Portfolio", "Team"]) {
      for (const row of rows(name)) await act(async () => button("Keep", row).click());
    }
    acceptMock.mockResolvedValue({ interaction: dashboardChangesFixture("edit", { status: "accepted" }), version: {} });
    await act(async () => button("Apply changes").click());
    expect(acceptMock).toHaveBeenCalledWith("issue-dashboard-conversation", "dashboard-changes-edit", undefined);
  });

  it("sends what should change with Not right", async () => {
    declineMock.mockResolvedValue(dashboardChangesFixture("edit", { status: "rejected", result: { version: 1, outcome: "declined" } }));
    addCommentMock.mockResolvedValue({});
    await render(<DashboardChangesCard interaction={dashboardChangesFixture("edit")} />);
    await act(async () => button("Not right").click());
    await act(async () => container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(declineMock).toHaveBeenCalledWith("issue-dashboard-conversation", "dashboard-changes-edit");
    expect(addCommentMock).toHaveBeenCalledWith("issue-dashboard-conversation", "Those dashboard changes aren't right yet.", true);
  });

  it("settles to one line", async () => {
    await render(<DashboardChangesCard interaction={dashboardChangesFixture("create", { status: "accepted", result: { version: 1, outcome: "accepted", summary: "Added 4 areas and 6 responsibilities" } })} />);
    expect(container.textContent).toBe("Dashboard changed: Added 4 areas and 6 responsibilities.");
    await render(<DashboardChangesCard interaction={dashboardChangesFixture("edit", { status: "rejected", result: { version: 1, outcome: "declined" } })} />);
    expect(container.textContent).toBe("Not these dashboard changes.");
  });
});
