// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyRuntimeButton } from "./CompanyRuntimeButton";

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("CompanyRuntimeButton", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders budget-resolution guidance for budget-paused companies", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <CompanyRuntimeButton
          companyPaused
          pauseReason="budget"
          onPause={() => undefined}
          onResume={() => undefined}
        />,
      );
    });

    const link = container.querySelector('a[href="/costs"]');
    expect(link?.textContent).toContain("Resolve budget");
    expect(container.textContent).not.toContain("Run");

    act(() => {
      root.unmount();
    });
  });
});
