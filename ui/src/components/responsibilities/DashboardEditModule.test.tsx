// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardFixtureAgents,
  dashboardStateFixture,
  dashboardVersionsFixture,
  latestChangeFixture,
} from "../../../storybook/fixtures/responsibility-dashboard";
import { DASHBOARD_UNDO_DISMISSED_STORAGE_KEY } from "@/lib/responsibility-dashboard";
import { ApiError } from "@/api/api-error";
import { DashboardEditModule } from "./DashboardEditModule";

const api = vi.hoisted(() => ({ state: vi.fn(), start: vi.fn(), versions: vi.fn(), restore: vi.fn(), accept: vi.fn(), decline: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@/api/responsibility-dashboard", () => ({ responsibilityDashboardApi: api }));
vi.mock("@/api/agents", () => ({ agentsApi: { get: vi.fn() } }));
vi.mock("@/api/issues", () => ({ issuesApi: { addComment: vi.fn() } }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => <a href={to} {...props}>{children}</a>,
  useNavigate: () => navigate,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DashboardEditModule", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onAddArea = vi.fn();

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  async function render(empty: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <DashboardEditModule companyId="company-storybook" ownerUserId="user-storybook" empty={empty} agentsById={dashboardFixtureAgents} onAddArea={onAddArea} />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
  }

  const buttons = () => [...container.querySelectorAll("button")].map((node) => node.textContent?.trim() || node.getAttribute("aria-label"));
  const button = (label: string, within: ParentNode = container) =>
    [...within.querySelectorAll("button")].find((node) => node.textContent?.trim() === label || node.getAttribute("aria-label") === label)!;

  it("on an empty dashboard: the heading, the line, one button naming the agent, and a quiet by-hand path", async () => {
    api.state.mockResolvedValue(dashboardStateFixture("empty"));
    await render(true);
    expect(container.querySelector("h2")?.textContent).toBe("Create your custom dashboard");
    expect(container.textContent).toContain("Have an agent research and interview you to generate a custom dashboard of areas and responsibilities that matter to you.");
    expect(buttons()).toEqual(["Start with Chief", "Add an area yourself"]);
    expect(button("Add an area yourself").className).toContain("text-muted-foreground");
    api.start.mockResolvedValue(dashboardStateFixture("empty_talking"));
    await act(async () => button("Start with Chief").click());
    await flush();
    expect(api.start).toHaveBeenCalledWith("company-storybook", { mode: "create", ownerUserId: "user-storybook" });
    expect(navigate).toHaveBeenCalledWith("/issues/PAP-120");
    await act(async () => button("Add an area yourself").click());
    expect(onAddArea).toHaveBeenCalled();
  });

  it("says so when no agent can do it, and leaves adding by hand as the way forward", async () => {
    api.state.mockResolvedValue(dashboardStateFixture("no_agent"));
    await render(true);
    expect(container.textContent).toContain("No agent is free to do this.");
    expect(buttons()).toEqual(["Add an area yourself"]);
  });

  it("on a populated dashboard: one quiet row that starts an edit, with Versions beside it", async () => {
    api.state.mockResolvedValue(dashboardStateFixture("populated"));
    await render(false);
    expect(container.querySelector("h2")).toBeNull();
    expect(buttons()).toEqual(["Edit your dashboard", "Versions"]);
    api.start.mockResolvedValue(dashboardStateFixture("talking"));
    await act(async () => button("Edit your dashboard").click());
    await flush();
    expect(api.start).toHaveBeenCalledWith("company-storybook", { mode: "edit", ownerUserId: "user-storybook" });
  });

  it("while a conversation is open, says so with the way into it", async () => {
    api.state.mockResolvedValue(dashboardStateFixture("talking"));
    await render(false);
    const talking = container.querySelector("[data-dashboard-talking]")!;
    expect(talking.textContent).toBe("Editing it with Chief. Open the conversation");
    expect(talking.querySelector("a")?.getAttribute("href")).toBe("/issues/PAP-120");
    api.state.mockResolvedValue(dashboardStateFixture("empty_talking"));
    await render(true);
    expect(container.querySelector("[data-dashboard-talking]")?.textContent).toBe("Talking it through with Chief. Open the conversation");
    expect(buttons()).toEqual(["Add an area yourself"]);
  });

  it("shows proposed changes right there, with the way into the conversation", async () => {
    api.state.mockResolvedValue(dashboardStateFixture("create_proposal"));
    await render(true);
    const card = container.querySelector("[data-testid='dashboard-changes']")!;
    expect(card.textContent).toContain("Chief proposes");
    expect(card.querySelector("a")?.getAttribute("href")).toBe("/issues/issue-dashboard-conversation");
    expect(button("Apply changes", card)).toBeTruthy();
    expect(container.querySelector("[data-dashboard-start]")).toBeNull();
  });

  it("after a change: what changed, and Undo restores the version before it", async () => {
    api.state.mockResolvedValue(dashboardStateFixture("applied"));
    api.restore.mockResolvedValue({ version: { ...latestChangeFixture, id: "version-undo", cause: "restore" } });
    await render(false);
    const line = container.querySelector("[data-dashboard-latest-change]")!;
    expect(line.textContent).toBe("Added 4 areas and 6 responsibilities.Undo");
    await act(async () => button("Undo").click());
    await flush();
    expect(api.restore).toHaveBeenCalledExactlyOnceWith("version-before");
    // Dismissed, it stays dismissed for that change.
    await act(async () => button("Dismiss").click());
    expect(container.querySelector("[data-dashboard-latest-change]")).toBeNull();
    expect(localStorage.getItem(DASHBOARD_UNDO_DISMISSED_STORAGE_KEY)).toBe(latestChangeFixture.id);
  });

  it("lists the versions plainly and restores one", async () => {
    api.state.mockResolvedValue(dashboardStateFixture("populated"));
    api.versions.mockResolvedValue(dashboardVersionsFixture);
    api.restore.mockResolvedValue({ version: dashboardVersionsFixture.versions[0] });
    await render(false);
    await act(async () => button("Versions").click());
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Previous versions");
    const rows = [...dialog.querySelectorAll("li")];
    expect(rows).toHaveLength(5);
    expect(rows[0]!.textContent).toContain("Added 1 responsibility");
    expect(rows[0]!.textContent).toContain("You");
    expect(rows[0]!.textContent).toContain("Now");
    expect(rows[1]!.textContent).toContain("Restored");
    expect(rows[2]!.textContent).toContain("Chief");
    expect([...dialog.querySelectorAll("button")].filter((node) => node.textContent?.trim() === "Restore")).toHaveLength(4);
    await act(async () => button("Restore", rows[3]!).click());
    await flush();
    expect(api.versions).toHaveBeenCalledWith("company-storybook", "user-storybook");
    expect(api.restore).toHaveBeenCalledExactlyOnceWith("version-2");
  });

  it("shows a failed read of the dashboard with Retry instead of a disabled button", async () => {
    api.state.mockRejectedValueOnce(new ApiError("Not allowed", 403, { error: "forbidden" }));
    await render(false);
    expect(container.querySelector('[data-query-view="error"]')).not.toBeNull();
    expect(buttons()).not.toContain("Edit your dashboard");
  });

  it("shows a failed refresh of the versions instead of the old list", async () => {
    api.state.mockResolvedValue(dashboardStateFixture("populated"));
    api.versions.mockResolvedValueOnce(dashboardVersionsFixture);
    await render(false);
    await act(async () => button("Versions").click());
    await flush();
    expect(document.querySelectorAll('[role="dialog"] li')).toHaveLength(5);
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    api.versions.mockRejectedValue(new ApiError("Not allowed", 403, { error: "forbidden" }));
    await act(async () => button("Versions").click());
    await flush();
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('[data-query-view="error"]')).not.toBeNull();
    expect(dialog.querySelectorAll("li")).toHaveLength(0);
  });
});
