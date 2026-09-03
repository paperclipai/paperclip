// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { AnchorHTMLAttributes, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PipelineCaseLiveness } from "@paperclipai/shared";
import { PipelineLivenessBanner } from "./PipelineLivenessBanner";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act<T>(callback: () => T): T {
  let result: T | undefined;
  flushSync(() => {
    result = callback();
  });
  return result as T;
}

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

function render(element: ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

function click(element: Element | null) {
  if (!element) throw new Error("Expected element to exist");
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function liveness(overrides: Partial<PipelineCaseLiveness>): PipelineCaseLiveness {
  return { state: "attention", reason: "no_action_path", message: "stub", ...overrides } as PipelineCaseLiveness;
}

describe("PipelineLivenessBanner", () => {
  it("renders nothing for a running item", () => {
    const node = render(<PipelineLivenessBanner liveness={liveness({ reason: "linked_issue_active" })} />);
    expect(node.querySelector("section")).toBeNull();
  });

  it("renders a blocked banner with a blocking-issue link and no retry", () => {
    const node = render(
      <PipelineLivenessBanner
        liveness={liveness({
          state: "blocked",
          reason: "linked_issue_blocked",
          message: "Linked automation issue is blocked.",
          issue: { id: "auto-1", identifier: "PAP-900", title: "Build", status: "blocked" },
          blocker: { issueId: "blk-1", title: "Waiting on legal", status: "in_progress" },
        })}
        onRetry={() => {}}
      />,
    );
    const section = node.querySelector("section");
    expect(section?.getAttribute("aria-label")).toMatch(/Automation paused/);
    const links = Array.from(node.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toContain("/issues/blk-1");
    expect(links).toContain("/issues/PAP-900");
    expect(node.querySelector("button")).toBeNull();
  });

  it("invokes onRetry with the automation kind for restored permission", () => {
    const onRetry = vi.fn();
    const node = render(
      <PipelineLivenessBanner
        liveness={liveness({
          reason: "automation_failed",
          message: "Pipeline automation permission has been restored; retry the failed automation ledger.",
          automation: { automationId: "auto-3" },
        })}
        onRetry={onRetry}
      />,
    );
    const button = node.querySelector("button");
    expect(button?.textContent).toMatch(/Retry now/);
    click(button);
    expect(onRetry).toHaveBeenCalledWith("automation");
  });

  it("surfaces a retry error inline via role=alert", () => {
    const node = render(
      <PipelineLivenessBanner
        liveness={liveness({ reason: "automation_failed", message: "Automation failed.", automation: { automationId: null } })}
        onRetry={() => {}}
        retryError="Forbidden: missing pipelines:write"
      />,
    );
    const alert = node.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Forbidden/);
  });

  it("disables the retry button while pending", () => {
    const node = render(
      <PipelineLivenessBanner
        liveness={liveness({ reason: "no_action_path" })}
        onRetry={() => {}}
        retryPending
      />,
    );
    const button = node.querySelector("button") as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toMatch(/Retrying/);
  });
});
