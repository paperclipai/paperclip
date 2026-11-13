// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BreadcrumbProvider, buildDocumentTitle, useBreadcrumbs } from "./BreadcrumbContext";

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

  it("rerenders consumers when only the crumb identifier changes", () => {
    const renderCounts: number[] = [];
    let updateBreadcrumbs:
      | ((crumbs: Array<{ label: string; href?: string; identifier?: string }>) => void)
      | null = null;

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
      updateBreadcrumbs?.([{ label: "First task prompt", identifier: "PAP-1204" }]);
    });

    expect(renderCounts).toHaveLength(2);

    // Same everything but a new identifier must produce a fresh render.
    act(() => {
      updateBreadcrumbs?.([{ label: "First task prompt", identifier: "PAP-1205" }]);
    });

    expect(renderCounts).toHaveLength(3);

    // Identical identifier is a no-op.
    act(() => {
      updateBreadcrumbs?.([{ label: "First task prompt", identifier: "PAP-1205" }]);
    });

    expect(renderCounts).toHaveLength(3);
  });

  it("builds page titles with the selected company name before Paperclip", () => {
    expect(buildDocumentTitle([{ label: "Inbox" }], "Anachronist Wiki")).toBe(
      "Inbox • Anachronist Wiki • Paperclip",
    );
    expect(
      buildDocumentTitle(
        [{ label: "Issues", href: "/issues" }, { label: "PAP-3515" }],
        "Anachronist Wiki",
      ),
    ).toBe("PAP-3515 • Issues • Anachronist Wiki • Paperclip");
  });

  it("omits blank company names from page titles", () => {
    expect(buildDocumentTitle([{ label: "Inbox" }], "  ")).toBe("Inbox • Paperclip");
    expect(buildDocumentTitle([], null)).toBe("Paperclip");
  });
});
