// @vitest-environment jsdom

import { act as reactAct } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueRow } from "./IssueRow";
import { StatusIcon } from "./StatusIcon";

vi.mock("@/lib/router", () => ({
  Link: ({
    children,
    className,
    disableIssueQuicklook: _disableIssueQuicklook,
    issuePrefetch,
    ...props
  }: React.ComponentProps<"a"> & { disableIssueQuicklook?: boolean; issuePrefetch?: Issue | null }) => (
    <a
      className={className}
      data-disable-issue-quicklook={_disableIssueQuicklook ? "true" : undefined}
      data-issue-prefetch-id={issuePrefetch?.id}
      {...props}
    >
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  if (typeof reactAct === "function") {
    reactAct(callback);
    return;
  }

  flushSync(callback);
}

function createIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "issue-1",
    identifier: "PAP-1",
    companyId: "company-1",
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Inbox item",
    description: null,
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
    createdAt: new Date("2026-03-11T00:00:00.000Z"),
    updatedAt: new Date("2026-03-11T00:00:00.000Z"),
    labels: [],
    labelIds: [],
    myLastTouchAt: null,
    lastExternalCommentAt: null,
    isUnreadForMe: false,
    ...overrides,
    workMode: overrides.workMode ?? "standard",
  };
}

describe("IssueRow", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the list status glyph at md (16px)", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueRow issue={createIssue({ status: "in_progress" })} />);
    });

    const glyphs = container.querySelectorAll('svg[viewBox="0 0 24 24"]');
    expect(glyphs.length).toBeGreaterThan(0);
    glyphs.forEach((glyph) => {
      expect(glyph.getAttribute("width")).toBe("16");
      expect(glyph.getAttribute("height")).toBe("16");
    });

    act(() => {
      root.unmount();
    });
  });

  it("keeps editable row controls keyboard-accessible and outside the navigation link", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueRow
          issue={createIssue()}
          desktopMetaLeading={<StatusIcon status="todo" onChange={() => undefined} />}
        />,
      );
    });

    const link = container.querySelector<HTMLAnchorElement>("[data-inbox-issue-link]");
    const statusButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Change status (current: Todo)"]',
    );

    expect(link).not.toBeNull();
    expect(statusButton).not.toBeNull();
    expect(statusButton?.tabIndex).toBe(0);
    expect(link?.contains(statusButton)).toBe(false);

    act(() => {
      root.unmount();
    });
  });

  it("suppresses accent hover styling when the row is selected", () => {
    const root = createRoot(container);
    const issue = createIssue();

    act(() => {
      root.render(<IssueRow issue={issue} selected />);
    });

    // The hover wash lives on the ROOT row band (not the overlay link) so the
    // tint paints behind the content. Selected rows suppress the accent hover.
    const row = container.firstElementChild as HTMLElement | null;
    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    expect(row).not.toBeNull();
    expect(row?.className).toContain("hover:bg-transparent");
    expect(row?.className).not.toContain("hover:bg-accent/50");
    // The overlay link no longer carries the hover wash.
    expect(link?.className ?? "").not.toContain("hover:bg-transparent");
    expect(link?.className ?? "").not.toContain("hover:bg-accent/50");

    act(() => {
      root.unmount();
    });
  });

  it("neutralizes selected status and unread dot accents", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueRow issue={createIssue()} selected unreadState="visible" />);
    });

    const markReadButton = container.querySelector('button[aria-label="Mark as read"]');
    const unreadDot = markReadButton?.querySelector("span");
    // Selected rows neutralize the status glyph to muted via `!`-important
    // utilities, which override the glyph's inline colour var. The glyph is an
    // <svg> (SVGAnimatedString className), so match on the class attribute.
    const statusGlyph = container.querySelector('svg[class*="text-muted-foreground"]');

    expect(markReadButton).not.toBeNull();
    expect(markReadButton?.className).toContain("hover:bg-muted/80");
    expect(markReadButton?.className).not.toContain("hover:bg-blue-500/20");
    expect(unreadDot).not.toBeNull();
    expect(unreadDot?.className).toContain("bg-muted-foreground/70");
    expect(unreadDot?.className).not.toContain("bg-blue-600");
    expect(statusGlyph).not.toBeNull();
    expect(statusGlyph?.getAttribute("class")).toContain("!text-muted-foreground");
    expect(statusGlyph?.getAttribute("class")).toContain("!border-muted-foreground");

    act(() => {
      root.unmount();
    });
  });

  it("reserves the leading dot slot on read rows so unread rows never indent past them", () => {
    const root = createRoot(container);
    act(() => {
      // A read inbox row still supplies `unreadState` (as "hidden").
      root.render(<IssueRow issue={createIssue()} unreadState="hidden" />);
    });

    // The desktop dot slot is reserved even when read (empty), so unread rows
    // add no column and line up with read rows.
    const slot = container.querySelector('[data-testid="issue-row-unread-slot"]');
    expect(slot).not.toBeNull();
    expect(slot?.className).toContain("w-4");
    expect(slot?.className).toContain("sm:inline-flex");
    // In flow, not an absolute overlay.
    expect(slot?.className).not.toContain("absolute");
    // Read rows carry no dot button in the slot.
    expect(slot?.querySelector('button[aria-label="Mark as read"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("puts the unread dot in the reserved desktop slot and overlays it on mobile", () => {
    const root = createRoot(container);
    act(() => {
      root.render(<IssueRow issue={createIssue()} unreadState="visible" />);
    });

    // Desktop: the dot lives in the reserved leading slot (far left, ahead of
    // any leading control such as a parent's collapse caret).
    const slot = container.querySelector('[data-testid="issue-row-unread-slot"]');
    expect(slot).not.toBeNull();
    expect(slot?.querySelector('button[aria-label="Mark as read"]')).not.toBeNull();

    // Mobile: all inbox rows reserve a gutter and the dot stays fully inside
    // it, so the control cannot be clipped or indent the status/title.
    const mobileDot = container
      .querySelector('button[aria-label="Mark as read"].sm\\:hidden, span.sm\\:hidden button[aria-label="Mark as read"]')
      ?.closest("span.sm\\:hidden");
    expect(mobileDot).not.toBeNull();
    expect(mobileDot?.className).toContain("absolute");
    expect(mobileDot?.className).toContain("left-0");
    expect(mobileDot?.className).not.toContain("order-first");
    expect(container.firstElementChild?.className).toContain("pl-4");

    act(() => {
      root.unmount();
    });
  });

  it("preserves the issue detail breadcrumb source and href in the link target", () => {
    const root = createRoot(container);
    const issue = createIssue();
    const state = {
      issueDetailBreadcrumb: { label: "Inbox", href: "/PAP/inbox/mine" },
      issueDetailSource: "inbox",
    };

    act(() => {
      root.render(<IssueRow issue={issue} issueLinkState={state} />);
    });

    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("to") ?? link?.getAttribute("href")).toBe("/issues/PAP-1");

    act(() => {
      root.unmount();
    });
  });

  it("opts issue quicklook out for dense inbox rows", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueRow issue={createIssue()} />);
    });

    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.getAttribute("data-disable-issue-quicklook")).toBe("true");

    act(() => {
      root.unmount();
    });
  });

  it("passes the visible row issue into the navigation prefetch path", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueRow issue={createIssue()} />);
    });

    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    expect(link?.getAttribute("data-issue-prefetch-id")).toBe("issue-1");

    act(() => {
      root.unmount();
    });
  });

  it("renders titleSuffix inline after the issue title", () => {
    const root = createRoot(container);
    const issue = createIssue({ title: "Parent task" });

    act(() => {
      root.render(
        <IssueRow
          issue={issue}
          titleSuffix={<span data-testid="suffix">(3 sub-tasks)</span>}
        />,
      );
    });

    const titleEl = container.querySelector(".line-clamp-2, .truncate");
    expect(titleEl?.textContent).toContain("Parent task");
    expect(titleEl?.textContent).toContain("(3 sub-tasks)");
    expect(container.querySelector('[data-testid="suffix"]')).not.toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders checklist step numbers beside the issue identifier", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueRow
          issue={createIssue({ identifier: "PAP-42" })}
          checklistStepNumber="2.1"
          mobileMeta="updated now"
        />,
      );
    });

    const metaRow = Array.from(container.querySelectorAll("span.flex.items-center.gap-2"))
      .find((element) => element.textContent?.includes("PAP-42"));

    expect(metaRow).not.toBeUndefined();
    expect(metaRow?.textContent?.replace(/\s+/g, "")).toContain("2.1.PAP-42");

    act(() => {
      root.unmount();
    });
  });

  it("marks the current checklist step without adding a left border", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <IssueRow
          issue={createIssue({ identifier: "PAP-42" })}
          checklistStepNumber="2.1"
          checklistCurrentStep
        />,
      );
    });

    // `aria-current="step"` stays on the overlay link (the focusable target),
    // but the current-step wash moved to the ROOT row band alongside the hover
    // wash so it paints behind the content.
    const row = container.firstElementChild as HTMLElement | null;
    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;

    expect(link).not.toBeNull();
    expect(link?.getAttribute("aria-current")).toBe("step");
    expect(row?.className).toContain("bg-primary/5");
    expect(row?.className).not.toContain("border-l-");
    expect(link?.className ?? "").not.toContain("bg-primary/5");

    act(() => {
      root.unmount();
    });
  });

  it("does not render a planning mode marker for planning work mode issues", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueRow issue={createIssue({ workMode: "planning" })} />);
    });

    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link?.textContent).not.toContain("Planning");

    act(() => {
      root.unmount();
    });
  });

  it("renders without error when titleSuffix is omitted", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueRow issue={createIssue()} />);
    });

    const titleEl = container.querySelector(".line-clamp-2, .truncate");
    expect(titleEl?.textContent).toContain("Inbox item");

    act(() => {
      root.unmount();
    });
  });

  it("flags rows blocked by an assigned-backlog leaf with a parked-work badge", () => {
    const root = createRoot(container);
    const issue = createIssue({
      blockedBy: [
        {
          id: "blocker-1",
          identifier: "PAP-2",
          title: "Parked child",
          status: "backlog",
          priority: "high",
          assigneeAgentId: "agent-99",
          assigneeUserId: null,
        },
      ],
    });

    act(() => {
      root.render(<IssueRow issue={issue} />);
    });

    const badges = container.querySelectorAll('[data-testid="issue-row-parked-blocker"]');
    expect(badges.length).toBeGreaterThan(0);
    expect(badges[0]?.textContent).toContain("Blocked by parked work");

    act(() => {
      root.unmount();
    });
  });

  it("does not show the parked-work badge when assigned blocker is not in backlog", () => {
    const root = createRoot(container);
    const issue = createIssue({
      blockedBy: [
        {
          id: "blocker-1",
          identifier: "PAP-2",
          title: "Active child",
          status: "in_progress",
          priority: "high",
          assigneeAgentId: "agent-99",
          assigneeUserId: null,
        },
      ],
    });

    act(() => {
      root.render(<IssueRow issue={issue} />);
    });

    expect(container.querySelector('[data-testid="issue-row-parked-blocker"]')).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("renders no bottom divider by default", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueRow issue={createIssue()} />);
    });

    // Dividers are opt-in: without `showDivider` no row-separating border
    // renders on either the root band or the overlay link.
    const row = container.firstElementChild as HTMLElement | null;
    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    expect(row).not.toBeNull();
    expect(row?.className).not.toContain("border-b");
    expect(link?.className ?? "").not.toContain("border-b");

    act(() => {
      root.unmount();
    });
  });

  it("renders an opt-in bottom divider on the row root when showDivider is set", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueRow issue={createIssue()} showDivider />);
    });

    // The divider lives on the ROOT row band with `last:border-b-0` so the real
    // last row drops its border — it is not on the overlay link.
    const row = container.firstElementChild as HTMLElement | null;
    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    expect(row?.className).toContain("border-b");
    expect(row?.className).toContain("last:border-b-0");
    expect(link?.className ?? "").not.toContain("border-b");

    act(() => {
      root.unmount();
    });
  });

  it("keeps the hover wash on the row root while the overlay link stays a bare positioning layer", () => {
    const root = createRoot(container);

    act(() => {
      root.render(<IssueRow issue={createIssue()} />);
    });

    const row = container.firstElementChild as HTMLElement | null;
    const link = container.querySelector("[data-inbox-issue-link]") as HTMLAnchorElement | null;
    // Hover wash paints behind the content on the root band...
    expect(row?.className).toContain("hover:bg-accent/50");
    expect(link?.className ?? "").not.toContain("hover:bg-accent/50");
    // ...and the overlay link keeps only positioning + focus concerns.
    expect(link?.className).toContain("absolute");
    expect(link?.className).toContain("inset-0");

    act(() => {
      root.unmount();
    });
  });
});
