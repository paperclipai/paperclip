// @vitest-environment jsdom

import { type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { RecentIssue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "./ui/tooltip";
import { SidebarRecentIssues } from "./SidebarRecentIssues";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: {
    to: string;
    children: ReactNode;
  }) => <a href={to} {...props}>{children}</a>,
  NavLink: ({ to, children, className, ...props }: {
    to: string;
    children: ReactNode;
    className?: string | ((state: { isActive: boolean }) => string);
  }) => (
    <a
      href={to}
      className={typeof className === "function" ? className({ isActive: false }) : className}
      {...props}
    >
      {children}
    </a>
  ),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({
    isMobile: false,
    setSidebarOpen: vi.fn(),
    collapsed: sidebarState.collapsed,
    peeking: sidebarState.peeking,
  }),
}));

const sidebarState = vi.hoisted(() => ({ collapsed: false, peeking: false }));

const recentIssue = (overrides: Partial<RecentIssue> = {}): RecentIssue => ({
  id: "issue-1",
  identifier: "PAP-1",
  title: "First task",
  status: "in_progress",
  kind: "commented",
  lastInteractedAt: "2026-08-27T13:00:00.000Z",
  hasActiveRun: false,
  needsAttention: false,
  attentionHref: null,
  ...overrides,
});

describe("SidebarRecentIssues", () => {
  let container: HTMLDivElement;
  let root: Root;

  function renderRecent(props: React.ComponentProps<typeof SidebarRecentIssues>) {
    flushSync(() => {
      root.render(
        <TooltipProvider>
          <SidebarRecentIssues {...props} />
        </TooltipProvider>,
      );
    });
  }

  beforeEach(() => {
    sidebarState.collapsed = false;
    sidebarState.peeking = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    document.body.innerHTML = "";
  });

  it("renders nothing for an empty recent list", () => {
    renderRecent({ issues: [], liveIssueIds: new Set() });
    expect(container.innerHTML).toBe("");
  });

  it("uses endpoint decorations initially and exposes text equivalents", () => {
    renderRecent({
      issues: [recentIssue({
        hasActiveRun: true,
        needsAttention: true,
        attentionHref: "/issues/PAP-1#interaction-request-1",
      })],
      liveIssueIds: undefined,
    });

    expect(container.textContent).toContain("Needs you");
    expect(container.textContent).not.toContain("live");
    expect(container.querySelector('[aria-label="Live run"]')).not.toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/issues/PAP-1#interaction-request-1");
  });

  it("does not restore attention that the recent-issues endpoint excluded", () => {
    renderRecent({ issues: [recentIssue({ needsAttention: false, attentionHref: null })] });

    expect(container.textContent).not.toContain("Needs you");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/issues/PAP-1");
  });

  it("keeps server order stable when live and attention decorations change", () => {
    const issues = [
      recentIssue({ id: "issue-1", identifier: "PAP-1", title: "Newest" }),
      recentIssue({ id: "issue-2", identifier: "PAP-2", title: "Older" }),
    ];
    renderRecent({ issues, liveIssueIds: new Set(["issue-2"]) });
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["Newest", "Older"]);

    renderRecent({ issues, liveIssueIds: new Set(["issue-1"]) });
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["Newest", "Older"]);
  });

  it("dims terminal rows and safely truncates hostile titles", () => {
    const hostileTitle = `${"Long title ".repeat(30)}😀 שלום <script>alert(1)</script> \"quoted\"`;
    renderRecent({
      issues: [recentIssue({ title: hostileTitle, status: "done" })],
      liveIssueIds: new Set(),
    });

    const title = [...container.querySelectorAll("span")].find((node) => node.textContent === hostileTitle);
    expect(title?.className).toContain("truncate");
    expect(title?.className).toContain("text-muted-foreground");
    expect(title?.closest("a")?.className).toContain("min-w-0");
    expect(document.querySelector("script")).toBeNull();
  });

  it("preserves the browser focus outline on recent task links", () => {
    renderRecent({ issues: [recentIssue()] });

    const link = container.querySelector('a[href="/issues/PAP-1"]');
    expect(link?.className).not.toContain("focus-visible:outline-none");
    expect(link?.className).not.toContain("focus-visible:ring");
  });

  it("expands from 10 to 25 in memory and resets after remount", () => {
    const issues = Array.from({ length: 25 }, (_, index) => recentIssue({
      id: `issue-${index + 1}`,
      identifier: `PAP-${index + 1}`,
      title: `Task ${index + 1}`,
    }));
    renderRecent({ issues });

    expect(container.querySelectorAll('a[href^="/issues/PAP-"]')).toHaveLength(10);
    const showMore = [...container.querySelectorAll("button")].find((button) => button.textContent === "Show more…");
    flushSync(() => showMore?.click());
    expect(container.querySelectorAll('a[href^="/issues/PAP-"]')).toHaveLength(25);
    expect(container.textContent).toContain("Show fewer");
    expect(container.querySelector('a[href="/issues?touchedByUserId=me&sortField=last_interaction&sortDir=desc"]')?.textContent)
      .toContain("All my activity");

    flushSync(() => root.unmount());
    root = createRoot(container);
    renderRecent({ issues });
    expect(container.querySelectorAll('a[href^="/issues/PAP-"]')).toHaveLength(10);
  });

  it("uses one rail clock with an aggregate amber dot and restores the same rows in the peek", () => {
    const issues = [
      recentIssue({ id: "issue-1", title: "Newest" }),
      recentIssue({
        id: "issue-2",
        title: "Needs review",
        needsAttention: true,
        attentionHref: "/issues/PAP-1#interaction-request-2",
      }),
    ];
    sidebarState.collapsed = true;
    renderRecent({ issues });

    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.querySelector('a[href="/issues?touchedByUserId=me&sortField=last_interaction&sortDir=desc"]')).not.toBeNull();
    expect(container.querySelector(".bg-amber-500")).not.toBeNull();
    expect(container.textContent).not.toContain("Newest");

    sidebarState.peeking = true;
    renderRecent({ issues });
    expect([...container.querySelectorAll("a")].map((link) => link.textContent)).toEqual(["Newest", "Needs reviewNeeds you"]);
  });
});
