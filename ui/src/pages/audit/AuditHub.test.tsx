// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditHub } from "./AuditHub";

const navigateMock = vi.hoisted(() => vi.fn());
const setSearchParamsMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
let currentSearch = "";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/lib/router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [new URLSearchParams(currentSearch), setSearchParamsMock],
}));

vi.mock("./AuditFeed", () => ({
  AuditFeed: (props: Record<string, unknown>) => (
    <div
      data-testid="audit-feed"
      data-mode={props.mode}
      data-agent={props.lockedAgentId}
      data-run={props.lockedRunId}
      data-entity={JSON.stringify(props.lockedEntity ?? null)}
      data-action={props.actionDomain}
    />
  ),
}));

vi.mock("./AuditRuns", () => ({
  AuditRuns: ({ companyId, routineId }: { companyId: string; routineId?: string }) => (
    <div data-testid="audit-runs" data-company={companyId} data-routine={routineId} />
  ),
}));

vi.mock("./RoutineAuditActivity", () => ({
  RoutineAuditActivity: ({ companyId, routineId }: { companyId: string; routineId: string }) => (
    <div data-testid="routine-audit-activity" data-company={companyId} data-routine={routineId} />
  ),
}));

vi.mock("@/pages/Costs", () => ({
  Costs: (props: Record<string, unknown>) => (
    <div
      data-testid="audit-costs"
      data-initial-tab={props.initialTab}
      data-lock-tab={String(props.lockTab ?? false)}
      data-hide-budgets={String(props.hideBudgetsTab ?? false)}
    />
  ),
}));

vi.mock("@/pages/Timeline", () => ({
  Timeline: ({ embedded }: { embedded?: boolean }) => (
    <div data-testid="audit-timeline" data-embedded={String(embedded ?? false)} />
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AuditHub", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    currentSearch = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => root?.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  function render(section: "activity" | "runs" | "costs" | "budgets" | "timeline") {
    root = createRoot(container);
    flushSync(() => root.render(<AuditHub section={section} />));
  }

  it("uses one clear section model and passes deep-link scopes to Activity", () => {
    currentSearch = "mode=agents&agentId=agent-1&runId=run-1&action=tool_";
    render("activity");

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(5);
    expect(container.textContent).toContain("Activity");
    expect(container.textContent).toContain("Runs");
    expect(container.textContent).toContain("Costs");
    expect(container.textContent).toContain("Budgets");
    expect(container.textContent).toContain("Timeline");
    const feed = container.querySelector<HTMLElement>('[data-testid="audit-feed"]');
    expect(feed?.dataset.mode).toBe("agents");
    expect(feed?.dataset.agent).toBe("agent-1");
    expect(feed?.dataset.run).toBe("run-1");
    expect(feed?.dataset.entity).toBe(JSON.stringify(null));
    expect(feed?.dataset.action).toBe("tool_");
    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Audit" }]);
  });

  it("uses routine-scoped activity instead of the privileged organization feed", () => {
    currentSearch = "entityType=routine&entityId=routine-1";
    render("activity");

    expect(container.querySelector('[data-testid="audit-feed"]')).toBeNull();
    const activity = container.querySelector<HTMLElement>('[data-testid="routine-audit-activity"]');
    expect(activity?.dataset.company).toBe("company-1");
    expect(activity?.dataset.routine).toBe("routine-1");
  });

  it("passes routine scope to the Runs section", () => {
    currentSearch = "entityType=routine&entityId=routine-1";
    render("runs");

    const runs = container.querySelector<HTMLElement>('[data-testid="audit-runs"]');
    expect(runs?.dataset.company).toBe("company-1");
    expect(runs?.dataset.routine).toBe("routine-1");
  });

  it("renders Timeline as the section after Budgets", () => {
    render("timeline");

    const labels = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'))
      .map((tab) => tab.textContent?.trim());
    expect(labels).toEqual(["Activity", "Runs", "Costs", "Budgets", "Timeline"]);
    expect(container.querySelector<HTMLElement>('[data-testid="audit-timeline"]')?.dataset.embedded)
      .toBe("true");
  });

  it("renders Costs and Budgets as intentional peer sections", () => {
    render("budgets");
    let costs = container.querySelector<HTMLElement>('[data-testid="audit-costs"]');
    expect(costs?.dataset.initialTab).toBe("budgets");
    expect(costs?.dataset.lockTab).toBe("true");

    flushSync(() => root.unmount());
    render("costs");
    costs = container.querySelector<HTMLElement>('[data-testid="audit-costs"]');
    expect(costs?.dataset.initialTab).toBe("overview");
    expect(costs?.dataset.hideBudgets).toBe("true");
  });

  it("keeps the current entity scope when moving between Audit sections", () => {
    currentSearch = "entityType=routine&entityId=routine-1";
    render("activity");

    const runsTab = Array.from(container.querySelectorAll<HTMLElement>('[role="tab"]'))
      .find((tab) => tab.textContent?.trim() === "Runs");
    expect(runsTab).toBeTruthy();
    flushSync(() => {
      runsTab!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      runsTab!.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
    });
    expect(navigateMock).toHaveBeenCalledWith(
      "/activity/runs?entityType=routine&entityId=routine-1",
    );
  });
});
