// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { IssueOrphanDeliverableSignal } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueOrphanDeliverableBadge } from "./IssueOrphanDeliverableBadge";
import { TooltipProvider } from "./ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSignal(overrides: Partial<IssueOrphanDeliverableSignal> = {}): IssueOrphanDeliverableSignal {
  return {
    reason: "no_documents_no_agent_comments",
    status: "done",
    flaggedSince: new Date("2026-05-12T00:00:00.000Z"),
    hasDocuments: false,
    hasAgentComments: false,
    ...overrides,
  };
}

describe("IssueOrphanDeliverableBadge", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("renders the badge with the default label", () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <IssueOrphanDeliverableBadge signal={makeSignal()} />
        </TooltipProvider>,
      );
    });
    const badge = container.querySelector('[data-testid="issue-orphan-deliverable-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain("No deliverable");
    expect(badge?.getAttribute("aria-label")).toBe("No deliverable artifact attached");
  });

  it("hides the label when hideLabel is true", () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <IssueOrphanDeliverableBadge signal={makeSignal()} hideLabel />
        </TooltipProvider>,
      );
    });
    const badge = container.querySelector('[data-testid="issue-orphan-deliverable-badge"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent ?? "").not.toContain("No deliverable");
  });

  it("accepts an ISO string for flaggedSince", () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <IssueOrphanDeliverableBadge
            signal={{
              ...makeSignal(),
              flaggedSince: new Date("2026-05-12T00:00:00.000Z").toISOString() as unknown as Date,
            }}
          />
        </TooltipProvider>,
      );
    });
    const badge = container.querySelector('[data-testid="issue-orphan-deliverable-badge"]');
    expect(badge).not.toBeNull();
  });
});
