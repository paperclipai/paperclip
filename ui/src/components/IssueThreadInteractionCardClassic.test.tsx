// @vitest-environment jsdom

import { act } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { rejectedSuggestedTasksInteraction } from "../fixtures/issueThreadInteractionFixtures";
import { ThemeProvider } from "../context/ThemeContext";
import { TooltipProvider } from "./ui/tooltip";
import { IssueThreadInteractionCardClassic } from "./IssueThreadInteractionCardClassic";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

describe("IssueThreadInteractionCardClassic", () => {
  it("keeps resolved decisions compact until the operator expands history", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <TooltipProvider>
          <ThemeProvider>
            <IssueThreadInteractionCardClassic interaction={rejectedSuggestedTasksInteraction} />
          </ThemeProvider>
        </TooltipProvider>,
      );
    });

    const summary = host.querySelector('button[aria-expanded="false"]') as HTMLButtonElement | null;
    expect(summary).toBeTruthy();
    expect(host.textContent).toContain("Rejected");

    act(() => summary?.click());
    expect(host.textContent).toContain("Hide history");

    act(() => root.unmount());
    host.remove();
  });
});
