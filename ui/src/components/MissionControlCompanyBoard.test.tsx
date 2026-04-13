// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/router", () => ({
  Link: ({ children, className, ...props }: React.ComponentProps<"a">) => (
    <a className={className} {...props}>{children}</a>
  ),
}));

const now = new Date().toISOString();
const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();

const queryResults = [
  { data: [
    { id: "i1", identifier: "ORD-14", title: "Company Health Monitor — graphrag-memory-ops", status: "todo", priority: "high", updatedAt: now },
    { id: "i2", identifier: "ORD-21", title: "Cross Company Priority Board", status: "blocked", priority: "critical", updatedAt: now },
    { id: "i3", identifier: "ORD-22", title: "Executive Weekly Summary", status: "done", priority: "medium", updatedAt: now },
  ] },
  { data: [
    { id: "p1", name: "Company Health Board", status: "in_progress" },
    { id: "p2", name: "Executive Weekly Reporting", status: "planned" },
  ] },
  { data: [
    { id: "g1", title: "전체 시스템 가시성 확보", status: "planned" },
    { id: "g2", title: "병목과 오류 조기 감지", status: "planned" },
  ] },
  { data: [
    { id: "r1", title: "Daily Company Health Routine", status: "active", lastRun: { triggeredAt: now, status: "succeeded" } },
    { id: "r2", title: "Weekly Executive Summary Routine", status: "active", lastRun: { triggeredAt: now, status: "succeeded" } },
  ] },
  { data: [
    { id: "ev1", action: "heartbeat.failed", entityType: "heartbeat_run", entityId: "hb1", createdAt: now },
    { id: "ev2", action: "issue.updated", entityType: "issue", entityId: "i2", createdAt: now },
  ] },
  { data: [
    { id: "ag1", name: "CEO", role: "ceo", status: "idle", lastHeartbeatAt: now },
    { id: "ag2", name: "CTO", role: "cto", status: "idle", lastHeartbeatAt: now },
    { id: "ag3", name: "Hermes Engineer", role: "engineer", status: "idle", lastHeartbeatAt: now },
  ] },
  { data: [
    { id: "hb1", agentId: "ag3", status: "failed", errorCode: "process_lost", triggerDetail: "issue_assigned", invocationSource: "assignment", createdAt: threeHoursAgo },
    { id: "hb2", agentId: "ag3", status: "timed_out", errorCode: "timeout", triggerDetail: "issue_assigned", invocationSource: "assignment", createdAt: threeHoursAgo },
    { id: "hb3", agentId: "ag2", status: "failed", errorCode: "adapter_failed", triggerDetail: "schedule", invocationSource: "timer", createdAt: threeHoursAgo },
    { id: "hb4", agentId: "ag3", status: "succeeded", triggerDetail: "issue_assigned", invocationSource: "assignment", createdAt: now },
    { id: "hb5", agentId: "ag2", status: "succeeded", triggerDetail: "schedule", invocationSource: "timer", createdAt: now },
    { id: "hb6", agentId: "ag1", status: "succeeded", triggerDetail: "schedule", invocationSource: "timer", createdAt: now },
  ] },
];
let queryIndex = 0;

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryResults[queryIndex++] ?? { data: [] },
}));

vi.mock("../api/activity", () => ({ activityApi: { list: vi.fn() } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn() } }));
vi.mock("../api/goals", () => ({ goalsApi: { list: vi.fn() } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { list: vi.fn() } }));
vi.mock("../api/issues", () => ({ issuesApi: { list: vi.fn() } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn() } }));
vi.mock("../api/routines", () => ({ routinesApi: { list: vi.fn() } }));
vi.mock("../lib/queryKeys", () => ({
  queryKeys: {
    issues: { list: () => ["issues"] },
    projects: { list: () => ["projects"] },
    goals: { list: () => ["goals"] },
    routines: { list: () => ["routines"] },
    activity: () => ["activity"] ,
    agents: { list: () => ["agents"] },
    heartbeats: () => ["heartbeats"],
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { MissionControlCompanyBoard } from "./MissionControlCompanyBoard";

describe("MissionControlCompanyBoard", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    queryIndex = 0;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the mission control board with a four-card hero and recovery breakdown like the ops board pattern", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<MissionControlCompanyBoard companyId="3014ef48-d6c5-4ce2-90b7-5e05e6483686" />);
    });

    const links = Array.from(container.querySelectorAll("a"));
    const agentsLink = links.find((link) => link.textContent?.includes("Agents 열기"));
    const projectsLink = links.find((link) => link.textContent?.includes("Projects 열기"));
    const goalsLink = links.find((link) => link.textContent?.includes("Goals 열기"));
    const routinesLink = links.find((link) => link.textContent?.includes("Routines 열기"));

    expect(container.textContent).toContain("Mission Control Board");
    expect(container.textContent).toContain("Issues 3");
    expect(container.textContent).toContain("Projects 2");
    expect(container.textContent).toContain("Goals 2");
    expect(container.textContent).toContain("Company / Agent Health");
    expect(container.textContent).toContain("Control Queue");
    expect(container.textContent).toContain("Recovery / Reliability");
    expect(container.textContent).toContain("Live Signals");
    expect(container.textContent).toContain("historical failed heartbeat");
    expect(container.textContent).toContain("recovered agents");
    expect(container.textContent).toContain("Failure Breakdown");
    expect(container.textContent).toContain("Hermes Engineer");
    expect(container.textContent).toContain("process_lost");
    expect(container.querySelector('a[href="#company-agent-health"]')).toBeNull();
    expect(agentsLink?.getAttribute("to")).toBe("/agents");
    expect(projectsLink?.getAttribute("to")).toBe("/projects");
    expect(goalsLink?.getAttribute("to")).toBe("/goals");
    expect(routinesLink?.getAttribute("to")).toBe("/routines");
    expect(container.textContent).not.toContain("Company health monitors");
    expect(container.textContent).not.toContain("Recent failures");
    expect(container.textContent).not.toContain("Activity feed");

    act(() => {
      root.unmount();
    });
  });
});
