// @vitest-environment jsdom

import type { Issue, IssueOverview } from "@paperclipai/shared";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectOperatorOverview, type ProjectOperatorOverviewProps } from "./ProjectOperatorOverview";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, title, className }: { children?: ReactNode; to: string; title?: string; className?: string }) => (
    <a href={to} title={title} className={className}>
      {children}
    </a>
  ),
}));

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

let issueCounter = 0;
function issue(overrides: Record<string, unknown> = {}): Issue {
  issueCounter += 1;
  return {
    id: `issue-${issueCounter}`,
    identifier: null,
    title: "Task title",
    status: "todo",
    priority: "medium",
    parentId: null,
    updatedAt: "2026-09-01T00:00:00Z",
    completedAt: null,
    labels: [],
    ...overrides,
  } as unknown as Issue;
}

function overview(issueId: string, overrides: Partial<IssueOverview> = {}): IssueOverview {
  return {
    issueId,
    phase: "in_progress",
    phaseSource: "status",
    blocked: false,
    project: null,
    parent: null,
    children: [],
    childCount: 0,
    completedChildCount: 0,
    blocker: null,
    pullRequests: [],
    delivery: null,
    ...overrides,
  };
}

function baseProps(overrides: Partial<ProjectOperatorOverviewProps> = {}): ProjectOperatorOverviewProps {
  return {
    tasksHref: "/projects/demo/issues",
    issues: [],
    issuesLoading: false,
    issuesError: null,
    issuesObservedAt: 0,
    issuesRefreshing: false,
    onRetryIssues: vi.fn(),
    truncated: false,
    overviewsById: new Map<string, IssueOverview>(),
    overviewsPending: false,
    overviewsError: null,
    overviewsObservedAt: 0,
    onRetryOverviews: vi.fn(),
    onRefreshAll: vi.fn(),
    planTaskIds: new Set<string>(),
    ...overrides,
  };
}

describe("ProjectOperatorOverview", () => {
  let root: Root | null = null;
  let container: HTMLDivElement;

  async function render(props: ProjectOperatorOverviewProps) {
    root = createRoot(container);
    await act(async () => {
      root!.render(<ProjectOperatorOverview {...props} />);
    });
  }

  function click(element: Element | null | undefined) {
    expect(element).toBeTruthy();
    flushSync(() => element!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(() => root?.unmount());
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("shows a loading state while the inventory loads", async () => {
    await render(baseProps({ issues: undefined, issuesLoading: true }));
    expect(container.querySelector('[data-testid="project-operator-overview-loading"]')).not.toBeNull();
    expect(container.textContent).toContain("Loading snapshot");
  });

  it("shows the inventory error with a working retry", async () => {
    const onRetryIssues = vi.fn();
    await render(baseProps({ issuesError: new Error("boom"), onRetryIssues }));
    expect(container.querySelector('[data-testid="project-operator-overview-issues-error"]')).not.toBeNull();
    expect(container.textContent).toContain("Could not load project tasks: boom");
    click(
      [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry"),
    );
    expect(onRetryIssues).toHaveBeenCalledTimes(1);
  });

  it("explains an empty project without manual setup steps", async () => {
    await render(baseProps({ issues: [] }));
    expect(container.querySelector('[data-testid="project-operator-overview-empty"]')).not.toBeNull();
    expect(container.textContent).toContain("No tasks in this project yet");
    const link = container.querySelector('[data-testid="project-operator-overview-empty"] a');
    expect(link?.getAttribute("href")).toBe("/projects/demo/issues");
  });

  it("lanes explicit roadmap labels on root outcomes and says so", async () => {
    await render(
      baseProps({
        issues: [
          issue({ id: "a", status: "in_progress", labels: [{ name: "Now" }] }),
          issue({ id: "b", status: "todo", labels: [{ name: "next" }] }),
          issue({ id: "c", status: "backlog", labels: [{ name: "later" }] }),
        ],
      }),
    );
    const lanes = container.querySelector('[data-testid="project-operator-overview-lanes"]')!;
    expect(lanes.textContent).toContain("Now");
    expect(lanes.textContent).toContain("Next");
    expect(lanes.textContent).toContain("Later");
    expect(container.textContent).toContain("explicit now / next / later labels");
    expect(container.textContent).not.toContain("fall back to Active");
  });

  it("falls back to Active/Ready/Backlog without inventing roadmap labels", async () => {
    await render(
      baseProps({
        issues: [
          issue({ id: "a", status: "in_progress", title: "Flying" }),
          issue({ id: "b", status: "todo", title: "Queued" }),
          issue({ id: "c", status: "backlog", title: "Parked" }),
        ],
      }),
    );
    const lanes = container.querySelector('[data-testid="project-operator-overview-lanes"]')!;
    expect(lanes.textContent).toContain("Active");
    expect(lanes.textContent).toContain("Ready");
    expect(lanes.textContent).toContain("Backlog");
    expect(lanes.textContent).toContain("Parked");
    expect(container.textContent).toContain("fall back to Active / Ready / Backlog");
    expect(container.textContent).toContain("not authorization to start");
  });

  it("nests execution children under their root outcome", async () => {
    await render(
      baseProps({
        issues: [
          issue({ id: "p", status: "in_progress", title: "Parent epic" }),
          issue({ id: "c1", status: "done", parentId: "p", title: "Child one" }),
          issue({ id: "c2", status: "todo", parentId: "p", title: "Child two" }),
        ],
      }),
    );
    const lanes = container.querySelector('[data-testid="project-operator-overview-lanes"]')!;
    expect(lanes.textContent).toContain("Parent epic");
    expect(lanes.textContent).toContain("Subtasks 1/2 done — parent outcome unchanged");
    expect(lanes.textContent).toContain("2 subtasks");
    expect(lanes.textContent).toContain("Child one");
    expect(container.textContent).toContain("1 root outcome");
  });

  it("reports outcome counts with an honest progressbar", async () => {
    await render(
      baseProps({
        issues: [
          issue({ id: "a", status: "done" }),
          issue({ id: "b", status: "cancelled" }),
          issue({ id: "c", status: "todo" }),
          issue({ id: "d", status: "todo" }),
        ],
      }),
    );
    const outcome = container.querySelector('[data-testid="project-operator-overview-outcome"]')!;
    expect(outcome.textContent).toContain("1 of 4 tasks done");
    expect(outcome.textContent).toContain("1 cancelled");
    const bar = outcome.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("1");
    expect(bar.getAttribute("aria-valuemax")).toBe("4");
  });

  it("links long task titles with full text available to keyboard and hover", async () => {
    const longTitle = "A very long task title that should wrap across lines ".repeat(6).trim();
    await render(
      baseProps({
        issues: [issue({ id: "a", status: "in_progress", identifier: "PAP-42", title: longTitle })],
      }),
    );
    const link = container.querySelector('[data-testid="project-operator-overview-lanes"] a')!;
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("/issues/PAP-42");
    expect(link.getAttribute("title")).toBe(longTitle);
    expect(link.textContent).toContain("PAP-42");
  });

  it("shows blockers with canonical owner, next action, and named refs", async () => {
    await render(
      baseProps({
        issues: [issue({ id: "b", status: "blocked", identifier: "PAP-1", title: "Stuck task" })],
        overviewsById: new Map([
          [
            "b",
            overview("b", {
              blocked: true,
              blocker: {
                message: "Waiting on API",
                ownerLabel: "Backend",
                nextAction: "Ship endpoint",
                issues: [{ id: "x", identifier: "PAP-9", title: "API", status: "in_progress" }],
              },
            }),
          ],
        ]),
      }),
    );
    const section = container.querySelector('[data-testid="project-operator-overview-blockers"]')!;
    expect(section.textContent).toContain("Owner: Backend");
    expect(section.textContent).toContain("Next: Ship endpoint");
    expect(section.textContent).toContain("Waiting on API");
    expect(section.querySelector('a[href="/issues/PAP-9"]')?.textContent).toBe("PAP-9");
    expect(section.querySelector('a[href="/decisions"]')).not.toBeNull();
  });

  it("flags stalled reviews as information, never as a decision", async () => {
    await render(
      baseProps({
        issues: [issue({ id: "r", status: "in_review", identifier: "PAP-7", title: "Waiting review" })],
        overviewsById: new Map([
          [
            "r",
            overview("r", {
              delivery: {
                phase: "review",
                artifactReady: true,
                reviewStatus: "stalled",
                blockingFindings: 2,
                queuePosition: null,
                nextAction: null,
                lastEventAt: null,
                mergedAt: null,
              },
            }),
          ],
        ]),
      }),
    );
    const section = container.querySelector('[data-testid="project-operator-overview-blockers"]')!;
    expect(section.textContent).toContain("Stalled review");
    expect(section.textContent).toContain("2 blocking findings");
    expect(section.textContent).not.toContain("Needs decision");
  });

  it("keeps lanes usable when delivery detail fails, with retry", async () => {
    const onRetryOverviews = vi.fn();
    await render(
      baseProps({
        issues: [issue({ id: "a", status: "in_progress", title: "Flying" })],
        overviewsError: new Error("detail down"),
        onRetryOverviews,
      }),
    );
    expect(container.textContent).toContain("Flying");
    const band = container.querySelector(
      '[data-testid="project-operator-overview-detail-error"]',
    )!;
    expect(band.textContent).toContain("Delivery detail unavailable: detail down");
    click([...band.querySelectorAll("button")].find((button) => button.textContent === "Retry"));
    expect(onRetryOverviews).toHaveBeenCalledTimes(1);
  });

  it("marks done tasks without merge evidence as unclassified, never non-code", async () => {
    await render(
      baseProps({
        issues: [issue({ id: "a", status: "done", identifier: "PAP-3", title: "Quiet task" })],
      }),
    );
    const section = container.querySelector('[data-testid="project-operator-overview-completed"]')!;
    expect(section.textContent).toContain("Completed tasks");
    expect(section.textContent).toContain("Marked done · delivery evidence not recorded");
    expect(section.textContent).not.toContain("Merged");
  });

  it("shows Merged only with a recorded delivery merge, plain Done for explicit non-code", async () => {
    const nonCode = { ...issue({ id: "n", status: "done", title: "Docs update" }), deliveryKind: "non_code" } as Issue;
    await render(
      baseProps({
        issues: [
          issue({ id: "m", status: "done", title: "Merged work" }),
          issue({ id: "h", status: "done", title: "Merged PR but open delivery" }),
          nonCode,
        ],
        overviewsById: new Map([
          [
            "m",
            overview("m", {
              phase: "merged",
              pullRequests: [
                { url: "https://git.example/r/pull/12", number: 12, repository: "r", state: "merged", updatedAt: "2026-09-04T00:00:00Z", stale: false },
              ],
              delivery: {
                phase: "merged",
                artifactReady: true,
                reviewStatus: "approved",
                blockingFindings: 0,
                queuePosition: null,
                nextAction: null,
                lastEventAt: null,
                mergedAt: "2026-09-04T00:00:00Z",
              },
            }),
          ],
          [
            "h",
            overview("h", {
              phase: "done",
              pullRequests: [
                { url: null, number: 3, repository: "r", state: "merged", updatedAt: "2026-09-04T00:00:00Z", stale: false },
              ],
              delivery: {
                phase: "done",
                artifactReady: false,
                reviewStatus: "none",
                blockingFindings: 0,
                queuePosition: null,
                nextAction: null,
                lastEventAt: null,
                mergedAt: null,
              },
            }),
          ],
        ]),
      }),
    );
    const section = container.querySelector('[data-testid="project-operator-overview-completed"]')!;
    // Exactly one task-level Merged marker plus the reading guide's explanation.
    expect(section.textContent!.match(/Merged/g)).toHaveLength(1);
    expect(section.textContent).toContain("Marked done · delivery evidence not recorded");
    expect(section.querySelector('a[href="https://git.example/r/pull/12"]')?.textContent).toContain("PR #12");
    expect(container.textContent).toContain("Merged appears only with a recorded delivery merge");
  });

  it("reports recorded plans without claiming zero when unknown", async () => {
    await render(
      baseProps({
        issues: [issue({ id: "a", status: "in_progress", title: "Planned work" })],
        planTaskIds: new Set(["a"]),
      }),
    );
    const lanes = container.querySelector('[data-testid="project-operator-overview-lanes"]')!;
    expect(lanes.textContent).toContain("Plan");
    const evidence = container.querySelector('[data-testid="project-operator-overview-evidence"]')!;
    expect(evidence.textContent).toContain("Plans recorded on 1 task");

    await render(baseProps({ issues: [issue({ id: "a", status: "todo" })], planTaskIds: undefined }));
    expect(
      container.querySelector('[data-testid="project-operator-overview-evidence"]')?.textContent,
    ).not.toContain("Plans recorded");
  });

  it("dedups one pull request covering several tasks", async () => {
    const shared = {
      url: "https://git.example/r/pull/9",
      number: 9,
      repository: "r",
      state: "open",
      updatedAt: null,
      stale: false,
    } as const;
    await render(
      baseProps({
        issues: [
          issue({ id: "a", status: "in_progress" }),
          issue({ id: "b", status: "todo" }),
        ],
        overviewsById: new Map([
          ["a", overview("a", { pullRequests: [{ ...shared }] })],
          ["b", overview("b", { pullRequests: [{ ...shared }] })],
        ]),
      }),
    );
    expect(
      container.querySelector('[data-testid="project-operator-overview-evidence"]')?.textContent,
    ).toContain("1 pull request (0 merged · 1 open)");
  });

  it("labels observation times as observed, not updated", async () => {
    await render(
      baseProps({
        issues: [issue({ id: "a", status: "todo" })],
        issuesObservedAt: Date.parse("2026-09-09T12:00:00Z"),
        overviewsObservedAt: Date.parse("2026-09-09T12:01:00Z"),
      }),
    );
    expect(container.textContent).toContain("Tasks observed");
    expect(container.textContent).toContain("Delivery detail observed");
    expect(container.textContent).not.toContain("Enrichment");
  });

  it("discloses a capped inventory honestly", async () => {
    await render(baseProps({ issues: [issue({ id: "a", status: "todo" })], truncated: true }));
    expect(
      container.querySelector('[data-testid="project-operator-overview-truncated"]')?.textContent,
    ).toContain("Inventory capped at the first 1 tasks");
  });

  it("keeps the long explanations behind a disclosure", async () => {
    await render(
      baseProps({
        issues: [issue({ id: "a", status: "done" }), issue({ id: "b", status: "todo" })],
      }),
    );
    const guide = container.querySelector('[data-testid="project-operator-overview-reading-guide"]')!;
    expect(guide.tagName).toBe("DETAILS");
    expect(guide.textContent).toContain("not business acceptance or operational readiness");
    expect(container.textContent).not.toMatch(/business ready|ready for business|accepted by/i);
  });
});
