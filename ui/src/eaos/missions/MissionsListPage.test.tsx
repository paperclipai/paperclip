// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.NODE_ENV === "production") {
    process.env.NODE_ENV = "test";
  }
});

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { Issue } from "@paperclipai/shared";

// CompanyContext stub — Link/NavLink wrappers in @/lib/router call useCompany().
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "PAP", status: "active" },
    selectedCompanyId: "company-1",
  }),
}));

const listMock = vi.fn();

vi.mock("@/api/issues", () => ({
  issuesApi: {
    list: (...args: unknown[]) => listMock(...args),
  },
}));

const agentsListMock = vi.fn();

vi.mock("@/api/agents", () => ({
  agentsApi: {
    list: (...args: unknown[]) => agentsListMock(...args),
  },
}));

const viewerRoleMock = vi.fn<() => { isOperator: boolean; isInstanceAdmin: boolean; membershipRole: string | null; loading: boolean }>();

vi.mock("../useEaosViewerRole", () => ({
  useEaosViewerRole: () => viewerRoleMock(),
}));

// IssueLinkQuicklook pulls in heavy popover machinery. Stub it to a plain
// anchor so we can still inspect the kernel backlink href without dragging in
// the quicklook query tree.
vi.mock("@/components/IssueLinkQuicklook", () => ({
  IssueLinkQuicklook: ({
    to,
    children,
    className,
    "data-testid": dataTestId,
  }: {
    to: string | { pathname?: string };
    children?: ReactNode;
    className?: string;
    "data-testid"?: string;
  }) => {
    const href = typeof to === "string" ? to : to.pathname ?? "#";
    return (
      <a href={href} className={className} data-testid={dataTestId ?? "kernel-link-stub"}>
        {children}
      </a>
    );
  },
}));

import { MissionsListPage } from "./MissionsListPage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const FIXED_NOW = new Date("2026-05-18T22:00:00.000Z");

function makeIssue(overrides: Partial<Issue>): Issue {
  return {
    id: "i1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Default",
    description: null,
    status: "in_progress",
    workMode: "standard",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: null,
    identifier: "LET-100",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-18T21:00:00.000Z"),
    updatedAt: new Date("2026-05-18T21:30:00.000Z"),
    ...overrides,
  };
}

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

let container: HTMLDivElement | null = null;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={makeQueryClient()}>
        <MemoryRouter initialEntries={["/eaos/missions"]}>
          <MissionsListPage now={FIXED_NOW} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  listMock.mockReset();
  agentsListMock.mockReset();
  agentsListMock.mockResolvedValue([]);
  viewerRoleMock.mockReset();
  // Default to customer (non-operator) so the existing "no posture chip"
  // assertions reflect the strictest viewer.
  viewerRoleMock.mockReturnValue({ isOperator: false, isInstanceAdmin: false, membershipRole: "member", loading: false });
});

afterEach(() => {
  if (container) {
    container.remove();
    container = null;
  }
});

describe("MissionsListPage", () => {
  it("renders a clean single-word title and no internal posture chips", async () => {
    listMock.mockResolvedValueOnce([]);
    await render();

    const title = container?.querySelector('[data-testid="eaos-missions-title"]');
    expect(title?.textContent).toBe("Missions");

    // Customer-visible UI must not surface implementation posture chips or
    // contract jargon (LET-503 §customer-friendly copy).
    const posture = container?.querySelector('[data-testid="eaos-missions-posture"]');
    expect(posture).toBeNull();
    const html = container?.innerHTML ?? "";
    expect(html).not.toContain("BACKEND-BACKED");
    expect(html).not.toContain("LET-409");
    expect(html).not.toContain("task-object");
  });

  it("hides BACKEND-BACKED/derived chips and raw field-name reasons for customer viewers when rows are populated", async () => {
    viewerRoleMock.mockReturnValue({ isOperator: false, isInstanceAdmin: false, membershipRole: "member", loading: false });
    listMock.mockResolvedValueOnce([
      makeIssue({
        id: "blocked-pop",
        identifier: "LET-B",
        status: "blocked",
        title: "Blocked populated mission",
        assigneeAgentId: "agent-1",
      }),
    ]);
    await render();

    const html = container?.innerHTML ?? "";
    // LET-503 round-4: the Linear-style flat list does not surface
    // backend-shaped tokens, raw issue field names, or implementation
    // posture chips anywhere in the customer DOM.
    expect(html).not.toContain("BACKEND-BACKED");
    expect(html).not.toContain("BACKED");
    expect(html).not.toContain("DERIVED");
    expect(html).not.toContain("FRESHNESS");
    expect(html).not.toContain("Backend status");
    expect(html).not.toContain("issue.assigneeAgentId");
    expect(html).not.toContain("issue.assigneeUserId");
    expect(html).not.toContain("issue.executionAgentNameKey");
    expect(html).not.toContain("NEXT GATE");
  });

  it("hides filler 'Continue active work' and zero-zero Dependencies for an active row with no blockers", async () => {
    viewerRoleMock.mockReturnValue({ isOperator: false, isInstanceAdmin: false, membershipRole: "member", loading: false });
    listMock.mockResolvedValueOnce([
      makeIssue({
        id: "active-quiet",
        identifier: "LET-Q",
        status: "in_progress",
        title: "Active quiet mission",
        assigneeAgentId: "agent-1",
      }),
    ]);
    await render();
    const html = container?.innerHTML ?? "";
    // The Linear-style compact row never emits these filler strings —
    // the test still acts as a regression guard against jargon coming
    // back in either the row or the bucket layout.
    expect(html).not.toContain("Continue active work");
    expect(html).not.toContain("Blocks 0 · Blocked by 0");
    // Compact row is wired — the avatar still renders for an agent owner.
    expect(
      container?.querySelector('[data-testid="eaos-missions-row-owner-avatar"]'),
    ).not.toBeNull();
  });

  it("renders the Linear-style List view by default with compact rows + status icon + priority + project + assignee avatar", async () => {
    viewerRoleMock.mockReturnValue({ isOperator: false, isInstanceAdmin: false, membershipRole: "member", loading: false });
    listMock.mockResolvedValueOnce([
      makeIssue({
        id: "active-1",
        identifier: "LET-A",
        status: "in_progress",
        priority: "high",
        title: "Active mission",
        assigneeAgentId: "agent-1",
        project: { id: "p1", urlKey: "growth", name: "Growth Q3" } as never,
      }),
      makeIssue({
        id: "blocked-1",
        identifier: "LET-B",
        status: "blocked",
        priority: "critical",
        title: "Blocked mission",
        assigneeAgentId: "agent-2",
      }),
    ]);
    await render();

    // Default view is the flat list — not the bucketed card layout.
    const page = container?.querySelector('[data-testid="eaos-missions-page"]');
    expect(page?.getAttribute("data-eaos-missions-mode")).toBe("list");
    expect(container?.querySelector('[data-testid="eaos-missions-list"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="eaos-missions-board"]')).toBeNull();

    // Compact rows render with status icon + priority + identifier +
    // project + owner avatar + updated time.
    const rows = Array.from(
      container?.querySelectorAll('[data-testid="eaos-missions-row"]') ?? [],
    );
    expect(rows.length).toBe(2);
    expect(rows[0]?.getAttribute("data-mission-primary-state")).toBe("active");
    expect(rows[0]?.getAttribute("data-mission-priority")).toBe("high");
    expect(rows[1]?.getAttribute("data-mission-primary-state")).toBe("blocked");
    expect(rows[1]?.getAttribute("data-mission-priority")).toBe("critical");

    // The row title is a link into the EAOS mission detail.
    const titleLink = rows[0]?.querySelector(
      '[data-testid="eaos-missions-row-title"]',
    ) as HTMLAnchorElement | null;
    expect(titleLink?.textContent).toContain("Active mission");
    expect(titleLink?.getAttribute("href") ?? "").toMatch(/\/eaos\/missions\/LET-A$/);

    // Project chip surfaces for the row that has a linked project.
    expect(rows[0]?.querySelector('[data-testid="eaos-missions-row-project"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-testid="eaos-missions-row-project"]')).toBeNull();

    // Owner avatar renders (deterministic) for agent assignees.
    expect(
      rows[0]?.querySelector('[data-testid="eaos-missions-row-owner-avatar"]'),
    ).not.toBeNull();
  });

  it("flips to the Kanban Board view via the view toggle", async () => {
    viewerRoleMock.mockReturnValue({ isOperator: false, isInstanceAdmin: false, membershipRole: "member", loading: false });
    listMock.mockResolvedValueOnce([
      makeIssue({ id: "active-1", identifier: "LET-A", status: "in_progress", title: "Active" }),
      makeIssue({ id: "blocked-1", identifier: "LET-B", status: "blocked", title: "Blocked" }),
    ]);
    await render();

    const boardTab = container?.querySelector(
      '[data-testid="eaos-missions-view-board"]',
    ) as HTMLButtonElement | null;
    expect(boardTab).not.toBeNull();
    await act(async () => {
      boardTab?.click();
    });
    await flush();

    const page = container?.querySelector('[data-testid="eaos-missions-page"]');
    expect(page?.getAttribute("data-eaos-missions-mode")).toBe("board");

    expect(container?.querySelector('[data-testid="eaos-missions-board"]')).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-missions-board-column-active"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-missions-board-column-blocked"]'),
    ).not.toBeNull();

    // Board cards link into the same mission detail.
    const cards = Array.from(
      container?.querySelectorAll('[data-testid="eaos-missions-board-card"]') ?? [],
    ) as HTMLAnchorElement[];
    expect(cards.length).toBe(2);
    expect(cards[0]?.getAttribute("href") ?? "").toMatch(/\/eaos\/missions\/LET-A$/);
  });

  it("shows the empty state when the backend returns zero issues", async () => {
    listMock.mockResolvedValueOnce([]);
    await render();

    const empty = container?.querySelector('[data-testid="eaos-missions-empty"]');
    expect(empty).not.toBeNull();
    // The view toggle is still rendered (header chrome stays consistent)
    // but the list/board surfaces are not — empty path takes precedence.
    expect(container?.querySelector('[data-testid="eaos-missions-list"]')).toBeNull();
    expect(container?.querySelector('[data-testid="eaos-missions-board"]')).toBeNull();
  });

  it("renders an error state and does NOT render any rows when the fetch fails", async () => {
    listMock.mockRejectedValueOnce(new Error("network exploded"));
    await render();
    await flush();

    const error = container?.querySelector('[data-testid="eaos-missions-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("network exploded");

    expect(container?.querySelector('[data-testid="eaos-missions-row"]')).toBeNull();
    expect(container?.querySelector('[data-testid="eaos-missions-list"]')).toBeNull();
  });

  it("renders status text + priority shorthand + assignee initials/name for a populated row", async () => {
    viewerRoleMock.mockReturnValue({ isOperator: false, isInstanceAdmin: false, membershipRole: "member", loading: false });
    agentsListMock.mockResolvedValueOnce([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { id: "agent-1", name: "Avery Chen", role: "engineer" } as any,
    ]);
    listMock.mockResolvedValueOnce([
      makeIssue({
        id: "row-1",
        identifier: "LET-LB",
        status: "in_progress",
        priority: "critical",
        title: "Ship Q3 growth dashboard",
        assigneeAgentId: "agent-1",
        project: { id: "p1", urlKey: "growth", name: "Growth Q3" } as never,
      }),
    ]);
    await render();

    const row = container?.querySelector('[data-testid="eaos-missions-row"]');
    expect(row).not.toBeNull();

    // Status block carries a visible text label so the icon is not the only
    // affordance for users to identify state.
    const status = row?.querySelector('[data-testid="eaos-missions-row-status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent ?? "").toContain("In progress");

    // Priority surfaces both an icon and the industry-standard P0/P1/P2
    // shorthand so reviewers can read it at a glance.
    const priority = row?.querySelector('[data-testid="eaos-missions-row-priority"]');
    expect(priority).not.toBeNull();
    expect(priority?.textContent ?? "").toContain("P0");
    expect(priority?.getAttribute("aria-label")).toBe("Priority: Critical");

    // Project chip surfaces the project name.
    const project = row?.querySelector('[data-testid="eaos-missions-row-project"]');
    expect(project).not.toBeNull();
    expect(project?.textContent ?? "").toContain("Growth Q3");

    // Owner cell renders an initials avatar plus the looked-up name.
    const owner = row?.querySelector('[data-testid="eaos-missions-row-owner"]');
    expect(owner).not.toBeNull();
    expect(owner?.textContent ?? "").toContain("AC"); // initials Avery Chen
    expect(owner?.textContent ?? "").toContain("Avery Chen");
    const avatar = owner?.querySelector('[data-testid="eaos-missions-row-owner-avatar"]');
    expect(avatar?.getAttribute("aria-label") ?? "").toContain("Avery Chen");
  });

  it("falls back to a non-empty owner label when the agent lookup has not loaded yet", async () => {
    viewerRoleMock.mockReturnValue({ isOperator: false, isInstanceAdmin: false, membershipRole: "member", loading: false });
    agentsListMock.mockResolvedValueOnce([]); // empty lookup
    listMock.mockResolvedValueOnce([
      makeIssue({
        id: "row-2",
        identifier: "LET-NL",
        status: "in_progress",
        priority: "high",
        title: "Audit access policies",
        assigneeAgentId: "agent-unknown",
      }),
    ]);
    await render();

    const owner = container?.querySelector('[data-testid="eaos-missions-row-owner"]');
    expect(owner).not.toBeNull();
    // Even without a real name we still surface a non-empty marker so the
    // row is never blank for an assigned mission.
    expect(owner?.textContent ?? "").toMatch(/[A-Za-z]/);
  });

  it("renders zero mutating controls — no approve/deploy/restart/rerun/apply buttons appear", async () => {
    listMock.mockResolvedValueOnce([
      makeIssue({ id: "i1", title: "[OPS] deploy hotfix to production" }),
    ]);
    await render();

    const buttons = Array.from(container?.querySelectorAll("button") ?? []);
    const buttonLabels = buttons.map((b) => (b.textContent ?? "").toLowerCase()).filter(Boolean);
    const forbidden = ["approve", "deploy", "restart", "rerun", "apply", "spend", "cleanup"];
    for (const label of buttonLabels) {
      for (const term of forbidden) {
        expect(
          label.includes(term),
          `Mission Control row must not render a "${term}" button (got "${label}")`,
        ).toBe(false);
      }
    }
  });
});
