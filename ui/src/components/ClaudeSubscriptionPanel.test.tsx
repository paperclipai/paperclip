// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { QuotaWindow } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeSubscriptionPanel } from "./ClaudeSubscriptionPanel";

function render(container: HTMLElement, ui: ReactNode): void {
  // The panel is a pure render with no effects, so a flushSync render gives us
  // a settled DOM tree without needing React's `act`. (React 19 dropped the
  // `react` re-export of `act`; the codebase's other component tests are mid-
  // migration to RTL, so we keep this file standalone.)
  const root = createRoot(container);
  flushSync(() => {
    root.render(ui);
  });
}

function rowLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".text-sm.font-medium.text-foreground")).map(
    (node) => node.textContent?.trim() ?? "",
  );
}

const fullWindows: QuotaWindow[] = [
  { label: "Current session", usedPercent: 46, resetsAt: null, valueLabel: null, detail: null },
  { label: "Weekly (all models)", usedPercent: 74, resetsAt: null, valueLabel: null, detail: null },
  { label: "Weekly (Sonnet)", usedPercent: 58, resetsAt: null, valueLabel: null, detail: null },
  { label: "Weekly (Opus)", usedPercent: 92, resetsAt: null, valueLabel: null, detail: null },
  { label: "Extra usage", usedPercent: null, resetsAt: null, valueLabel: "$0.00", detail: null },
];

describe("ClaudeSubscriptionPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the Sonnet row when seven_day_sonnet is present in the payload", () => {
    render(container, <ClaudeSubscriptionPanel windows={fullWindows} source="anthropic-oauth" />);
    const labels = rowLabels(container);
    expect(labels).toContain("Weekly (Sonnet)");
    expect(labels).toContain("Weekly (all models)");
    expect(labels).toContain("Weekly (Opus)");
  });

  it("hides the Sonnet row when seven_day_sonnet is absent from the payload", () => {
    const noSonnet = fullWindows.filter((w) => w.label !== "Weekly (Sonnet)");
    render(container, <ClaudeSubscriptionPanel windows={noSonnet} source="anthropic-oauth" />);
    const labels = rowLabels(container);
    expect(labels).not.toContain("Weekly (Sonnet)");
    expect(labels).toContain("Weekly (all models)");
    expect(labels).toContain("Weekly (Opus)");
  });

  it("renders without crashing when Sonnet utilization exceeds all-models utilization", () => {
    // Anthropic shouldn't return this shape, but the panel must not throw if
    // upstream ever ships a payload where the per-model meter is higher than
    // the aggregate. Both rows render; clamp/warn behavior is not asserted here.
    const sonnetExceedsAll = fullWindows.map((w) => {
      if (w.label === "Weekly (all models)") return { ...w, usedPercent: 30 };
      if (w.label === "Weekly (Sonnet)") return { ...w, usedPercent: 80 };
      return w;
    });
    expect(() => {
      render(container, <ClaudeSubscriptionPanel windows={sonnetExceedsAll} source="anthropic-oauth" />);
    }).not.toThrow();
    const labels = rowLabels(container);
    expect(labels).toContain("Weekly (all models)");
    expect(labels).toContain("Weekly (Sonnet)");
  });
});
