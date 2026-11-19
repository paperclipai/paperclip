// @vitest-environment jsdom
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderRateLimitSnapshot } from "@paperclipai/shared";
import { AgentRateLimitPropertyValue } from "./AgentRateLimitGauge";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="usage-popover">{children}</div>,
}));
vi.mock("@/lib/router", () => ({ Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a> }));

describe("usage limit property and popover", () => {
  const now = Date.parse("2099-11-18T19:33:34.353Z");
  const resetAt = "2099-11-18T20:17:34.353Z";
  let container: HTMLDivElement;
  let root: Root;
  const snapshot: ProviderRateLimitSnapshot = {
    schema: "paperclip.provider.rate_limits.v1", provider: "anthropic",
    windows: [{ id: "weekly", label: "Weekly", shortLabel: "7d", windowMinutes: 10080, usedPercent: 100, resetsAt: resetAt, status: "rejected" }],
    credits: null, limitReached: { windowId: "weekly", reason: "rate_limit_reached", resetsAt: resetAt },
    observedAt: "2099-11-18T19:28:34.353Z",
  };

  beforeEach(() => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["anthropic", "openai"] as const)("shows a live countdown and exact local deadline for %s", provider => {
    flushSync(() => root.render(<AgentRateLimitPropertyValue snapshot={{ ...snapshot, provider }} detailsHref="/agents/test-agent" defaultOpen />));
    const trigger = container.querySelector("button")!;
    const panel = container.querySelector('[data-testid="usage-popover"]')!;
    expect(trigger.textContent).toContain("resets in 44 minutes (Nov 18, 2099, 12:17 PM PST)");
    expect(panel.textContent).toContain(`${provider === "openai" ? "Codex" : "Claude"} usage limits`);
    expect(panel.textContent).toContain("Weekly100%");
    expect(panel.textContent).toContain("Resets in 44 minutes (Nov 18, 2099, 12:17 PM PST)");
    expect(panel.textContent).toContain("Reported Nov 18, 2099, 11:28 AM PST");
    expect(panel.querySelector("a")?.getAttribute("href")).toBe("/agents/test-agent");
    flushSync(() => vi.advanceTimersByTime(60_000));
    expect(trigger.textContent).toContain("resets in 43 minutes (");
    expect(panel.textContent).toContain("Resets in 43 minutes (");
  });

  it("clears stale exhausted usage when the reset passes", () => {
    flushSync(() => root.render(<AgentRateLimitPropertyValue snapshot={snapshot} defaultOpen />));
    expect(container.textContent).toContain("Limited");
    flushSync(() => vi.advanceTimersByTime(44 * 60_000));
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps an explicitly supplied clock fixed for stories and previews", () => {
    flushSync(() => root.render(<AgentRateLimitPropertyValue snapshot={snapshot} now={now} defaultOpen />));
    expect(vi.getTimerCount()).toBe(0);
    flushSync(() => vi.advanceTimersByTime(60 * 60_000));
    expect(container.textContent).toContain("in 44 minutes (");
  });
});
