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
        id: "active-pop",
        identifier: "LET-A",
        status: "in_progress",
        title: "Active populated mission",
        assigneeAgentId: "agent-1",
      }),
    ]);
    await render();

    const html = container?.innerHTML ?? "";
    expect(html).not.toContain("BACKEND-BACKED");
    expect(html).not.toContain("BACKED");
    expect(html).not.toContain("DERIVED");
    expect(html).not.toContain("FRESHNESS");
    expect(html).not.toContain("Backend status");
    expect(html).not.toContain("issue.assigneeAgentId");
    expect(html).not.toContain("issue.assigneeUserId");
    expect(html).not.toContain("issue.executionAgentNameKey");
    expect(html).not.toContain("NEXT GATE");
    // Customer-friendly labels are present.
    expect(html).toContain("Next step");
    expect(html).toContain("Dependencies");
  });

  it("surfaces operator provenance chips when viewer is operator-class", async () => {
    viewerRoleMock.mockReturnValue({ isOperator: true, isInstanceAdmin: true, membershipRole: "owner", loading: false });
    listMock.mockResolvedValueOnce([
      makeIssue({
        id: "active-ops",
        identifier: "LET-OPS",
        status: "in_progress",
        title: "Operator-visible mission",
        assigneeAgentId: "agent-1",
      }),
    ]);
    await render();
    expect(
      container?.querySelector('[data-testid="eaos-missions-truth-backend-backed"]'),
    ).not.toBeNull();
  });

  it("shows the empty state when the backend returns zero issues", async () => {
    listMock.mockResolvedValueOnce([]);
    await render();

    const empty = container?.querySelector('[data-testid="eaos-missions-empty"]');
    expect(empty).not.toBeNull();

    // Counts must NOT be inflated by preview/stub data when there are no rows.
    const summary = container?.querySelector('[data-testid="eaos-missions-summary"]');
    expect(summary).toBeNull();
  });

  it("renders mission rows bucketed by primary state with kernel backlinks", async () => {
    listMock.mockResolvedValueOnce([
      makeIssue({
        id: "active-1",
        identifier: "LET-A",
        status: "in_progress",
        title: "Active mission",
      }),
      makeIssue({
        id: "blocked-1",
        identifier: "LET-B",
        status: "blocked",
        title: "Blocked mission",
      }),
      makeIssue({
        id: "review-1",
        identifier: "LET-C",
        status: "in_review",
        title: "Review mission",
      }),
    ]);
    await render();

    expect(
      container?.querySelector('[data-testid="eaos-missions-bucket-active-rows"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-missions-bucket-blocked-rows"]'),
    ).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="eaos-missions-bucket-in-review-rows"]'),
    ).not.toBeNull();

    const summary = container?.querySelector('[data-testid="eaos-missions-summary-total"]');
    expect(summary?.textContent).toContain("3");

    const kernelLinks = Array.from(
      container?.querySelectorAll('[data-testid="eaos-missions-row-kernel-link"]') ?? [],
    );
    expect(kernelLinks.length).toBe(3);
    const hrefs = kernelLinks.map((link) => link.getAttribute("href") ?? "");
    // The Link wrapper applies the active company's prefix to internal hrefs.
    expect(hrefs.some((href) => href.endsWith("/issues/active-1"))).toBe(true);
  });

  it("renders an error state and does NOT render any rows when the fetch fails", async () => {
    listMock.mockRejectedValueOnce(new Error("network exploded"));
    await render();
    await flush();

    const error = container?.querySelector('[data-testid="eaos-missions-error"]');
    expect(error).not.toBeNull();
    expect(error?.textContent).toContain("network exploded");

    expect(container?.querySelector('[data-testid="eaos-missions-row"]')).toBeNull();
    expect(container?.querySelector('[data-testid="eaos-missions-summary"]')).toBeNull();
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

    // The advisory live-action chip should appear when the title mentions a
    // live-action category (e.g., "deploy") so operators still see the risk.
    expect(
      container?.querySelector('[data-testid="eaos-state-chip-approval-required"]'),
    ).not.toBeNull();
  });
});
