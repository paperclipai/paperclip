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

  it("includes a task identifier before its name without changing breadcrumb order", () => {
    expect(
      buildDocumentTitle(
        [{ label: "Issues" }, { label: "First task prompt", identifier: "PAP-1204" }],
        "Anachronist Wiki",
      ),
    ).toBe("PAP-1204 — First task prompt • Issues • Anachronist Wiki • Paperclip");
    expect(buildDocumentTitle([{ label: "First task prompt", identifier: "  PAP-1204  " }])).toBe(
      "PAP-1204 — First task prompt • Paperclip",
    );
  });

  it("keeps titles unchanged when identifiers are missing or blank", () => {
    expect(buildDocumentTitle([{ label: "First task prompt" }], "Anachronist Wiki")).toBe(
      "First task prompt • Anachronist Wiki • Paperclip",
    );
    expect(buildDocumentTitle([{ label: "First task prompt", identifier: "   " }])).toBe(
      "First task prompt • Paperclip",
    );
  });

  it("does not repeat an identifier that is already the label", () => {
    expect(buildDocumentTitle([{ label: "PAP-1204", identifier: "PAP-1204" }])).toBe(
      "PAP-1204 • Paperclip",
    );
    expect(buildDocumentTitle([{ label: "PAP-1204", identifier: "  PAP-1204  " }])).toBe(
      "PAP-1204 • Paperclip",
    );
  });

  it("omits blank company names from page titles", () => {
    expect(buildDocumentTitle([{ label: "Inbox" }], "  ")).toBe("Inbox • Paperclip");
    expect(buildDocumentTitle([], null)).toBe("Paperclip");
  });

  it("updates the document title when tasks and identifiers change", () => {
    let updateBreadcrumbs: ReturnType<typeof useBreadcrumbs>["setBreadcrumbs"] | null = null;

    function TestConsumer() {
      updateBreadcrumbs = useBreadcrumbs().setBreadcrumbs;
      return null;
    }

    act(() => {
      root.render(
        <BreadcrumbProvider companyName="Anachronist Wiki">
          <TestConsumer />
        </BreadcrumbProvider>,
      );
    });
    expect(document.title).toBe("Anachronist Wiki • Paperclip");

    act(() => {
      updateBreadcrumbs?.([{ label: "First task prompt", identifier: "PAP-1204" }]);
    });
    expect(document.title).toBe("PAP-1204 — First task prompt • Anachronist Wiki • Paperclip");

    act(() => {
      updateBreadcrumbs?.([{ label: "First task prompt", identifier: "PAP-1205" }]);
    });
    expect(document.title).toBe("PAP-1205 — First task prompt • Anachronist Wiki • Paperclip");

    act(() => {
      updateBreadcrumbs?.([{ label: "Second task prompt", identifier: "PAP-1206" }]);
    });
    expect(document.title).toBe("PAP-1206 — Second task prompt • Anachronist Wiki • Paperclip");

    act(() => {
      root.render(
        <BreadcrumbProvider companyName="Another Company">
          <TestConsumer />
        </BreadcrumbProvider>,
      );
    });
    expect(document.title).toBe("PAP-1206 — Second task prompt • Another Company • Paperclip");

    act(() => {
      updateBreadcrumbs?.([]);
    });
    expect(document.title).toBe("Another Company • Paperclip");
  });
});
