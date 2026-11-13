// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import type { Issue } from "@paperclipai/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS, IssueLinkQuicklook, QUICKLOOK_CONTENT_CLASS, quicklookAlignOffset } from "./IssueLinkQuicklook";

const mockIssuesApiGet = vi.hoisted(() => vi.fn());
const navigationPrefetches = vi.hoisted(() => [] as Array<{ ref: string; history: boolean }>);

vi.mock("@/lib/issueDetailCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/issueDetailCache")>();
  return {
    ...actual,
    prefetchIssueDetailForNavigation: (...args: Parameters<typeof actual.prefetchIssueDetailForNavigation>) => {
      navigationPrefetches.push({ ref: args[1], history: args[2]?.history === true });
      // The other quicklook tests rely on the real prefetch seeding the issue.
      return actual.prefetchIssueDetailForNavigation(args[0], args[1], { ...args[2], history: false });
    },
  };
});

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
    reviewPolicy: null,
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

  describe("navigation prefetch", () => {
    function renderLink({ quicklook = false } = {}) {
      navigationPrefetches.length = 0;
      act(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <MemoryRouter>
              <IssueLinkQuicklook issuePathId="PAP-1" issuePrefetch={createIssue()} to="/companies/company-1/issues/PAP-1" disableIssueQuicklook={!quicklook}>
                PAP-1
              </IssueLinkQuicklook>
            </MemoryRouter>
          </QueryClientProvider>,
        );
      });
      return container.querySelector("a") as HTMLAnchorElement;
    }
    const hover = (link: HTMLAnchorElement, type: "mouseover" | "mouseout") =>
      act(() => { link.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body })); });

    it("warms only the issue and recent comments when a pointer passes over a task", () => {
      const link = renderLink();
      hover(link, "mouseover");
      act(() => { vi.advanceTimersByTime(ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS - 1); });
      hover(link, "mouseout");
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(navigationPrefetches).toEqual([{ ref: "PAP-1", history: false }]);
    });

    it("waits for a hover to rest before warming history when the quicklook is on", () => {
      const link = renderLink({ quicklook: true });
      hover(link, "mouseover");
      act(() => { vi.advanceTimersByTime(ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS - 1); });
      hover(link, "mouseout");
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(navigationPrefetches).toEqual([{ ref: "PAP-1", history: false }]);
    });

    it("warms the full chat history once a hover rests on the task", () => {
      const link = renderLink();
      hover(link, "mouseover");
      act(() => { vi.advanceTimersByTime(ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS); });
      expect(navigationPrefetches).toEqual([{ ref: "PAP-1", history: false }, { ref: "PAP-1", history: true }]);
    });

    const press = (link: HTMLAnchorElement, pointerType: string) =>
      act(() => { link.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType })); });

    it("warms the full chat history at once when the task is pressed with a mouse", () => {
      const link = renderLink();
      press(link, "mouse");
      expect(navigationPrefetches).toEqual([{ ref: "PAP-1", history: true }]);
    });

    it("keeps a touch that may start a scroll to the light set until the click", () => {
      const link = renderLink();
      press(link, "touch");
      act(() => { link.dispatchEvent(new TouchEvent("touchstart", { bubbles: true })); });
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(navigationPrefetches.every((prefetch) => !prefetch.history)).toBe(true);
      expect(navigationPrefetches.length).toBeGreaterThan(0);
      act(() => { link.click(); });
      expect(navigationPrefetches.at(-1)).toEqual({ ref: "PAP-1", history: true });
    });

    it("warms history for keyboard focus only when the focus rests on the task", () => {
      const link = renderLink();
      act(() => { link.focus(); });
      act(() => { vi.advanceTimersByTime(ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS - 1); });
      act(() => { link.blur(); });
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(navigationPrefetches).toEqual([{ ref: "PAP-1", history: false }]);
      act(() => { link.focus(); });
      act(() => { vi.advanceTimersByTime(ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS); });
      expect(navigationPrefetches.at(-1)).toEqual({ ref: "PAP-1", history: true });
    });
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

  // The card is the standard task preview for the whole app, so its rows and
  // their order are the contract, not incidental markup.
  function openCard(trigger: HTMLAnchorElement) {
    act(() => {
      trigger.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      vi.advanceTimersByTime(200);
    });
    return document.querySelector('[data-slot="popover-content"]');
  }

  it("states identity, then title, then summary", () => {
    const card = openCard(
      renderQuicklook({
        status: "in_review",
        // The card reads only `name` off the project; the rest of `Project` is
        // irrelevant here, so this stands in for a full record.
        project: { id: "project-1", name: "Paperclip App" } as unknown as Issue["project"],
      }),
    );
    const text = card?.textContent ?? "";

    expect(text).toContain("PAP-1");
    expect(text).toContain("Paperclip App");
    expect(text).toContain("Quicklook title");
    expect(text).toContain("Quicklook description");
    expect(text.indexOf("PAP-1")).toBeLessThan(text.indexOf("Quicklook title"));
    expect(text.indexOf("Quicklook title")).toBeLessThan(text.indexOf("Quicklook description"));
  });

  // Status is the glyph, with no word of its own — so it must survive as the
  // glyph's accessible name rather than as shape and colour alone.
  it("carries the status on the glyph instead of spending a line on it", () => {
    const card = openCard(renderQuicklook({ status: "in_review" }));

    const glyph = card?.querySelector('[role="img"]');
    expect(glyph?.getAttribute("aria-label")).toBe("In review");

    // The status must reach a screen reader but occupy no visible text. Drop
    // the glyph (whose <title> counts toward textContent) and the word is gone.
    const withoutGlyph = card?.cloneNode(true) as HTMLElement;
    withoutGlyph.querySelector('[role="img"]')?.remove();
    expect(withoutGlyph.textContent).not.toContain("In review");
    expect(withoutGlyph.textContent).not.toContain("in_review");
  });

  it("shows no separator or project when the task has no project", () => {
    const card = openCard(renderQuicklook());

    expect(card?.querySelector('[data-testid="quicklook-project"]')).toBeNull();
    expect(card?.textContent).not.toContain("·");
  });

  // Radix aligns box to box, so the card's own padding would leave its text
  // inset from the trigger's. The offset cancels the padding in whichever
  // direction the card is aligned.
  it("offsets the card by its padding so its text lines up with the trigger", () => {
    // 12px of `p-3` padding plus the 1px border PopoverContent draws.
    expect(quicklookAlignOffset("start")).toBe(-13);
    expect(quicklookAlignOffset("end")).toBe(13);
    expect(quicklookAlignOffset("center")).toBe(0);
    expect(quicklookAlignOffset()).toBe(quicklookAlignOffset("start"));
    // The offset only holds while the shell keeps that padding.
    expect(QUICKLOOK_CONTENT_CLASS).toContain("p-3");
  });

  it("truncates a long project name but never the task key or the timestamp", () => {
    const card = openCard(
      renderQuicklook({
        project: { id: "p1", name: "Really loooong project name" } as unknown as Issue["project"],
      }),
    );

    const project = card?.querySelector('[data-testid="quicklook-project"]');
    expect(project?.getAttribute("title")).toBe("Really loooong project name");
    // The name is the only part allowed to give up width.
    expect(project?.querySelector(".truncate")?.textContent).toBe("Really loooong project name");
    expect(project?.getAttribute("class")).toContain("min-w-0");

    const key = Array.from(card?.querySelectorAll("span") ?? []).find((s) => s.textContent === "PAP-1");
    expect(key?.getAttribute("class")).toContain("shrink-0");
  });
});
