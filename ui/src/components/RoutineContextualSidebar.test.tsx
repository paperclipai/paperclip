// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RoutineContextualSidebar,
  resolveRoutineDetailDestination,
  routineActivityAuditHref,
  routineDetailHref,
  routineRunsAuditHref,
} from "./RoutineContextualSidebar";

vi.mock("@/lib/router", () => ({
  useParams: () => ({ routineId: "routine-route" }),
}));

vi.mock("@/api/routines", () => ({
  routinesApi: { get: vi.fn() },
}));

vi.mock("./ContextualSidebarFrame", () => ({
  ContextualSidebarFrame: ({
    surface,
    title,
    fallbackTo,
    showHeader,
    className,
    children,
  }: {
    surface: string;
    title: string;
    fallbackTo: string;
    showHeader?: boolean;
    className?: string;
    children: ReactNode;
  }) => (
    <aside
      className={className}
      data-surface={surface}
      data-title={title}
      data-fallback={fallbackTo}
      data-show-header={String(showHeader)}
    >
      {children}
    </aside>
  ),
}));

vi.mock("./SidebarNavItem", () => ({
  SidebarNavItem: ({ to, label }: { to: string; label: string }) => <a href={to}>{label}</a>,
}));

describe("routine contextual navigation", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
  });

  it("builds stable detail and scoped Audit destinations", () => {
    expect(routineDetailHref("routine-1")).toBe("/routines/routine-1/overview");
    expect(routineDetailHref("routine-1", "triggers")).toBe("/routines/routine-1/triggers");
    expect(routineRunsAuditHref("routine-1")).toBe(
      "/activity/runs?entityType=routine&entityId=routine-1",
    );
    expect(routineActivityAuditHref("routine-1")).toBe(
      "/activity?entityType=routine&entityId=routine-1",
    );
  });

  it("defaults and redirects legacy operation routes without remembering a prior section", () => {
    expect(resolveRoutineDetailDestination({ routineId: "routine-1" }))
      .toBe("/routines/routine-1/overview");
    expect(resolveRoutineDetailDestination({ routineId: "routine-1", section: "unknown" }))
      .toBe("/routines/routine-1/overview");
    expect(resolveRoutineDetailDestination({ routineId: "routine-1", section: "runs" }))
      .toBe("/activity/runs?entityType=routine&entityId=routine-1");
    expect(resolveRoutineDetailDestination({ routineId: "routine-1", legacyTab: "activity" }))
      .toBe("/activity?entityType=routine&entityId=routine-1");
  });

  it("renders the routine contextual sidebar with configuration and Audit links", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => root.render(
      <QueryClientProvider client={queryClient}>
        <RoutineContextualSidebar routineId="routine-1" title="Weekly release review" />
      </QueryClientProvider>,
    ));

    const frame = container.querySelector("aside");
    expect(frame?.getAttribute("data-surface")).toBe("routine");
    expect(frame?.getAttribute("data-title")).toBe("Weekly release review");
    expect(frame?.getAttribute("data-fallback")).toBe("/routines");
    expect(frame?.getAttribute("data-show-header")).toBe("false");
    expect(frame?.classList).toContain("bg-background");
    expect(frame?.classList).toContain("border-r");
    expect(container.querySelector('a[href="/routines/routine-1/overview"]')?.textContent).toBe("Overview");
    expect(container.querySelector('a[href="/routines/routine-1/triggers"]')?.textContent).toBe("Schedule");
    expect(container.querySelector('a[href="/activity/runs?entityType=routine&entityId=routine-1"]'))
      .not.toBeNull();
    expect(container.querySelector('a[href="/activity?entityType=routine&entityId=routine-1"]'))
      .not.toBeNull();
    expect(container.textContent).not.toContain("History");
  });
});
