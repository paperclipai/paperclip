// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Issue } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueLinkQuicklook } from "./IssueLinkQuicklook";

const mockIssuesApiGet = vi.hoisted(() => vi.fn());

vi.mock("@/api/issues", () => ({
  issuesApi: {
    get: mockIssuesApiGet,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Quicklook title",
    description: "Quicklook description",
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    responsibleUserId: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    workMode: "standard",
    ...overrides,
  };
}

describe("IssueLinkQuicklook", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    mockIssuesApiGet.mockResolvedValue(createIssue());
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("keeps portaled quicklook links mounted until after blur click handling", () => {
    const issue = createIssue();

    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <IssueLinkQuicklook
              issuePathId="PAP-1"
              issuePrefetch={issue}
              to="/companies/company-1/issues/PAP-1"
            >
              PAP-1
            </IssueLinkQuicklook>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    const trigger = container.querySelector("a") as HTMLAnchorElement | null;
    expect(trigger).not.toBeNull();

    act(() => {
      trigger?.focus();
    });

    expect(document.body.textContent).toContain("Quicklook title");

    act(() => {
      trigger?.blur();
    });

    expect(document.body.textContent).toContain("Quicklook title");

    act(() => {
      vi.runOnlyPendingTimers();
    });

    expect(document.body.textContent).not.toContain("Quicklook title");
  });

  // Regression: the quicklook could only be closed by a `mouseleave` on the
  // trigger or the card, and no leave event fires when the layout shifts the
  // trigger out from under a stationary pointer — expanding a decision row does
  // exactly that, stranding the card on screen. A pointer move anywhere clear of
  // both boxes now closes it.
  function renderQuicklook(issueOverrides: Partial<Issue> = {}) {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <IssueLinkQuicklook
              issuePathId="PAP-1"
              issuePrefetch={createIssue(issueOverrides)}
              to="/companies/company-1/issues/PAP-1"
            >
              PAP-1
            </IssueLinkQuicklook>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    return container.querySelector("a") as HTMLAnchorElement;
  }

  function movePointerTo(x: number, y: number) {
    act(() => {
      document.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y, bubbles: true }));
    });
  }

  it("closes an open quicklook once the pointer moves clear of the trigger and the card", () => {
    const trigger = renderQuicklook();

    act(() => {
      trigger.focus();
    });
    expect(document.body.textContent).toContain("Quicklook title");

    // jsdom reports zero-size rects, so every box sits at the origin; a move far
    // from it is unambiguously clear of both the trigger and the card.
    act(() => {
      trigger.blur();
    });
    movePointerTo(4000, 4000);

    expect(document.body.textContent).not.toContain("Quicklook title");
  });

  // Regression: Radix returns focus to the trigger when a popover closes, and
  // this link opens the quicklook `onFocus` — so dismissing it refocused the
  // trigger, which reopened it, and hovering away left the card up for good.
  it("does not reopen itself by taking focus back when it closes", () => {
    const trigger = renderQuicklook();

    act(() => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(200);
    });
    expect(document.body.textContent).toContain("Quicklook title");

    act(() => {
      trigger.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
      vi.runOnlyPendingTimers();
    });

    expect(document.activeElement).not.toBe(trigger);
    expect(document.body.textContent).not.toContain("Quicklook title");
  });

  it("keeps a focus-opened quicklook up while focus stays on the trigger", () => {
    const trigger = renderQuicklook();

    act(() => {
      trigger.focus();
    });
    expect(document.body.textContent).toContain("Quicklook title");

    // A keyboard user moving the mouse must not dismiss what focus opened.
    movePointerTo(4000, 4000);

    expect(document.body.textContent).toContain("Quicklook title");
  });

  // The card is the standard task preview for the whole app, so its four facts
  // and their order are the contract, not incidental markup.
  it("states identity, then title, then state, then summary", () => {
    const trigger = renderQuicklook({
      status: "in_review",
      // The card reads only `name` off the project; the rest of `Project` is
      // irrelevant here, so this stands in for a full record.
      project: { id: "project-1", name: "Paperclip App" } as unknown as Issue["project"],
    });

    act(() => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(200);
    });

    const card = document.querySelector('[data-slot="popover-content"]');
    const text = card?.textContent ?? "";
    expect(text).toContain("PAP-1");
    expect(text).toContain("Paperclip App");
    expect(text).toContain("Quicklook title");
    // Status reads as a word, sentence-cased — not "in_review" and not a chip.
    expect(text).toContain("In review");
    expect(text).not.toContain("in_review");
    expect(text).toContain("Quicklook description");

    // Identity precedes the title; the state line follows it.
    expect(text.indexOf("PAP-1")).toBeLessThan(text.indexOf("Quicklook title"));
    expect(text.indexOf("Quicklook title")).toBeLessThan(text.indexOf("In review"));
    expect(text.indexOf("In review")).toBeLessThan(text.indexOf("Quicklook description"));
  });
});
