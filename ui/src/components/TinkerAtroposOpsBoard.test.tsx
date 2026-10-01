// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, to, ...props }: React.ComponentProps<"a"> & { to?: string }) => (
    <a className={className} href={to} {...props}>{children}</a>
  ),
}));

function buildQueryResults({ issues }: { issues?: Array<{ id: string; identifier?: string; title: string; status: string; priority?: string; updatedAt?: string }> } = {}) {
  return [
    { data: issues ?? [
      { id: 'i1', identifier: 'TIN-7', title: 'Publish Ready Exporter Expansion', status: 'backlog', priority: 'medium', updatedAt: new Date().toISOString() },
      { id: 'i2', identifier: 'TIN-10', title: 'Dashboard V1 Build', status: 'backlog', priority: 'medium', updatedAt: new Date().toISOString() },
      { id: 'i3', identifier: 'TIN-1', title: 'Environment Status Monitor', status: 'done', priority: 'high', updatedAt: new Date().toISOString() },
    ] },
    { data: [
      { id: 'p1', name: 'System Inventory Board', status: 'in_progress' },
      { id: 'p2', name: 'Weekly Research Reporting', status: 'planned' },
    ] },
    { data: [
      { id: 'g1', title: '운영 가시성 확보', status: 'planned' },
    ] },
    { data: [
      { id: 'r1', title: 'Daily Environment and Run Audit', status: 'active', lastRun: { triggeredAt: new Date().toISOString(), status: 'issue_created' } },
    ] },
    { data: [
      { id: 'a1', action: 'issue.updated', entityType: 'issue', entityId: 'i2', createdAt: new Date().toISOString() },
    ] },
    { data: [
      { id: 'ag1', name: 'Tinker Atropos Ops Coordinator', role: 'devops', status: 'idle', lastHeartbeatAt: new Date().toISOString() },
    ] },
  ];
}

let queryResults = buildQueryResults();
let queryIndex = 0;

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryResults[queryIndex++] ?? { data: [] },
}));

vi.mock("../api/activity", () => ({ activityApi: { list: vi.fn() } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("../api/goals", () => ({ goalsApi: { list: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { list: vi.fn() } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn() } }));
vi.mock("../api/routines", () => ({ routinesApi: { list: vi.fn() } }));
vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    issues: { list: () => ["issues"] },
    projects: { list: () => ["projects"] },
    goals: { list: () => ["goals"] },
    routines: { list: () => ["routines"] },
    activity: () => ["activity"],
    agents: { list: () => ["agents"] },
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { TinkerAtroposOpsBoard } from "./TinkerAtroposOpsBoard";

describe("TinkerAtroposOpsBoard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    queryIndex = 0;
    queryResults = buildQueryResults();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the tinker ops board title and key operational sections", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<TinkerAtroposOpsBoard companyId="company-1" />);
    });

    expect(container.textContent).toContain("Tinker Atropos Ops Board");
    expect(container.textContent).toContain("Environment / Run Health");
    expect(container.textContent).toContain("Patch Queue + Export");
    expect(container.textContent).toContain("Live Signals");
    expect(container.textContent).toContain("Publish Ready Exporter Expansion");

    act(() => {
      root.unmount();
    });
  });

  it("renders direct action buttons when the patch queue has no open issues", () => {
    queryResults = buildQueryResults({
      issues: [
        { id: 'i1', identifier: 'TIN-1', title: 'Environment Status Monitor', status: 'done', priority: 'high', updatedAt: new Date().toISOString() },
      ],
    });
    const root = createRoot(container);

    act(() => {
      root.render(<TinkerAtroposOpsBoard companyId="company-1" />);
    });

    expect(container.textContent).toContain("지금 반영할 열린 patch 카드가 없다.");
    expect(container.textContent).toContain("새 feedback draft 나 운영 이슈가 생기면 여기에서 먼저 보인다.");

    const links = Array.from(container.querySelectorAll("a"));
    const issuesLink = links.find((link) => link.textContent?.includes("Issues 보기"));
    const feedbackDraftLink = links.find((link) => link.textContent?.includes("feedback draft 확인"));

    expect(issuesLink?.getAttribute("href")).toBe("/issues");
    expect(feedbackDraftLink?.getAttribute("href")).toBe("/issues?q=feedback%20draft");

    act(() => {
      root.unmount();
    });
  });
});
