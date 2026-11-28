// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { IssueRowDetailsNotice } from "./IssueRowDetailsNotice";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

describe("IssueRowDetailsNotice", () => {
  it("returns null when there is no error", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() => root.render(<IssueRowDetailsNotice error={null} onRetry={vi.fn()} />));
      expect(document.body.querySelector('[role="alert"]')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it("clears MobileBottomNav on mobile, constrains horizontal fit, and triggers retry", () => {
    const onRetry = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <IssueRowDetailsNotice
            error={new Error("network failed")}
            onRetry={onRetry}
          />,
        ),
      );
      const alert = document.body.querySelector('[role="alert"]') as HTMLElement | null;
      expect(alert).not.toBeNull();
      const classes = alert!.className.split(/\s+/);
      expect(classes).toContain("inset-x-4");
      expect(classes).toContain("bottom-(--mobile-nav-overlay-bottom)");
      expect(classes).toContain("md:bottom-4");
      expect(classes).toContain("sm:left-auto");
      expect(classes).toContain("sm:right-4");
      expect(classes).toContain("flex-wrap");

      const retryButton = alert!.querySelector("button");
      expect(retryButton?.textContent).toBe("Retry details");
      act(() => retryButton?.click());
      expect(onRetry).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });
});
