// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BreadcrumbProvider, useBreadcrumbs } from "./BreadcrumbContext";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("BreadcrumbContext", () => {
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

  it("does not rerender consumers when breadcrumbs are set to the same values", () => {
    const renderCounts: number[] = [];
    let updateBreadcrumbs: ((crumbs: Array<{ label: string; href?: string }>) => void) | null = null;

    function TestConsumer() {
      const { breadcrumbs, setBreadcrumbs } = useBreadcrumbs();
      renderCounts.push(breadcrumbs.length);
      updateBreadcrumbs = setBreadcrumbs;
      return null;
    }

    act(() => {
      root.render(
        <BreadcrumbProvider>
          <TestConsumer />
        </BreadcrumbProvider>,
      );
    });

    expect(renderCounts).toHaveLength(1);

    act(() => {
      updateBreadcrumbs?.([{ label: "Issues", href: "/issues" }, { label: "PAP-1488" }]);
    });

    expect(renderCounts).toHaveLength(2);

    act(() => {
      updateBreadcrumbs?.([{ label: "Issues", href: "/issues" }, { label: "PAP-1488" }]);
    });

    expect(renderCounts).toHaveLength(2);
  });
});
