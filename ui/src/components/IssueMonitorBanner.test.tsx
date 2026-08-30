// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { Issue } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  IssueMonitorBanner,
  IssueMonitorComposerStrip,
  buildMonitorSurfaceCopy,
  hasVisibleMonitorSurface,
} from "./IssueMonitorBanner";
import type { DerivedMonitorState } from "@/lib/issue-monitor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date("2026-07-17T20:00:00.000Z");

function derived(overrides: Partial<DerivedMonitorState> & { state: DerivedMonitorState["state"] }): DerivedMonitorState {
  return {
    source: "monitor",
    nextCheckAt: null,
    attemptCount: 0,
    serviceName: null,
    ...overrides,
  };
}

describe("buildMonitorSurfaceCopy", () => {
  it("leads with two-unit relative time while scheduled", () => {
    const copy = buildMonitorSurfaceCopy(
      derived({
        state: "scheduled",
        nextCheckAt: new Date(NOW.getTime() + (2 * 60 + 12) * 60_000).toISOString(),
        attemptCount: 1,
        serviceName: "vercel-deploy",
      }),
      NOW,
    );

    expect(copy).not.toBeNull();
    expect(copy!.bannerTitle).toBe("Waiting on monitor — resumes in 2h 12m");
    expect(copy!.stripTitle).toBe("Resumes in 2h 12m");
    expect(copy!.tone).toBe("info");
    expect(copy!.bannerMeta).toContain("Attempt 1");
    expect(copy!.bannerMeta).toContain("Watching: vercel-deploy");
    // Absolute time carries the "(your time)" hint on the banner only.
    expect(copy!.bannerMeta.some((piece) => piece.includes("(your time)"))).toBe(true);
    expect(copy!.stripMeta.some((piece) => piece.includes("(your time)"))).toBe(false);
  });

  it("keeps the retrying attempt count visible", () => {
    const copy = buildMonitorSurfaceCopy(
      derived({
        state: "retrying",
        nextCheckAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
        attemptCount: 3,
      }),
      NOW,
    );
    expect(copy!.stripTitle).toBe("Resumes in 1h 30m");
    expect(copy!.stripMeta).toContain("Attempt 3");
  });

  it("uses agent copy for scheduled retries without a monitor", () => {
    const copy = buildMonitorSurfaceCopy(
      derived({
        state: "retrying",
        source: "scheduled-retry",
        nextCheckAt: new Date(NOW.getTime() + 90 * 60_000).toISOString(),
        attemptCount: 2,
      }),
      NOW,
    );

    expect(copy!.bannerTitle).toBe("Agent resumes in 1h 30m");
    expect(copy!.stripTitle).toBe("Resumes in 1h 30m");
  });

  it("switches copy for due-now and overdue states", () => {
    const dueNow = buildMonitorSurfaceCopy(
      derived({ state: "due-now", nextCheckAt: NOW.toISOString(), attemptCount: 1 }),
      NOW,
    );
    expect(dueNow!.bannerTitle).toBe("Waiting on monitor — due now");
    expect(dueNow!.stripTitle).toBe("Due now");
    expect(dueNow!.bannerMeta).toContain("Checking momentarily…");
    expect(dueNow!.tone).toBe("info");

    const overdue = buildMonitorSurfaceCopy(
      derived({
        state: "overdue",
        nextCheckAt: new Date(NOW.getTime() - 18 * 60_000).toISOString(),
        attemptCount: 2,
      }),
      NOW,
    );
    expect(overdue!.bannerTitle).toBe("Waiting on monitor — overdue by 18m");
    expect(overdue!.stripTitle).toBe("Overdue by 18m");
    expect(overdue!.bannerMeta).toContain("Fires on next tick");
    expect(overdue!.tone).toBe("warning");
  });

  it("hides both surfaces when cleared, none, or without a next check", () => {
    expect(buildMonitorSurfaceCopy(derived({ state: "cleared", attemptCount: 2 }), NOW)).toBeNull();
    expect(buildMonitorSurfaceCopy(derived({ state: "none" }), NOW)).toBeNull();
    // A "scheduled" state with no timestamp cannot render an ETA — hide.
    expect(buildMonitorSurfaceCopy(derived({ state: "scheduled", nextCheckAt: null }), NOW)).toBeNull();
  });
});

describe("IssueMonitorBanner / IssueMonitorComposerStrip rendering", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  function issueWithMonitor(nextCheckAt: string | null): Issue {
    return {
      executionState: nextCheckAt
        ? { monitor: { status: "scheduled", nextCheckAt, attemptCount: 1, serviceName: "vercel-deploy" } }
        : null,
      scheduledRetry: null,
    } as unknown as Issue;
  }

  it("renders the banner with a working Check now button while waiting", () => {
    const onCheckNow = vi.fn();
    expect(hasVisibleMonitorSurface(issueWithMonitor(new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString()))).toBe(true);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <IssueMonitorBanner
          issue={issueWithMonitor(new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString())}
          onCheckNow={onCheckNow}
        />,
      );
    });

    expect(container.textContent).toContain("Waiting on monitor — resumes in 2h");
    expect(container.textContent).toContain("Watching: vercel-deploy");

    const button = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Check now"),
    );
    expect(button).toBeTruthy();
    flushSync(() => button?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(onCheckNow).toHaveBeenCalledTimes(1);

    flushSync(() => root.unmount());
  });

  it("hides the banner and strip when there is no monitor", () => {
    expect(hasVisibleMonitorSurface(issueWithMonitor(null))).toBe(false);
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <>
          <IssueMonitorBanner issue={issueWithMonitor(null)} onCheckNow={vi.fn()} />
          <IssueMonitorComposerStrip issue={issueWithMonitor(null)} onCheckNow={vi.fn()} />
        </>,
      );
    });
    expect(container.textContent).toBe("");
    flushSync(() => root.unmount());
  });

  it("renders the composer strip with the reply-wakes-agent hint", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <IssueMonitorComposerStrip
          issue={issueWithMonitor(new Date(NOW.getTime() + 2 * 60 * 60_000).toISOString())}
          onCheckNow={vi.fn()}
        />,
      );
    });

    expect(container.querySelector("[data-testid='issue-monitor-composer-strip']")).toBeTruthy();
    expect(container.textContent).toContain("Resumes in 2h");
    expect(container.textContent).toContain("Sending a reply wakes the agent now");

    flushSync(() => root.unmount());
  });
});
