// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseChildrenTree } from "./CaseChildrenTree";
import type { CaseSummary } from "@/api/cases";

function act(callback: () => void) {
  flushSync(callback);
}

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useCaseHref: () => (...segments: string[]) =>
    `/PAP/${["cases", ...segments].filter(Boolean).join("/")}`,
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function child(overrides: Partial<CaseSummary>): CaseSummary {
  return {
    id: Math.random().toString(36).slice(2),
    companyId: "c1",
    projectId: null,
    caseNumber: 1,
    identifier: "PAP-C1",
    caseType: "task",
    key: null,
    title: "A child",
    summary: null,
    status: "in_progress",
    fields: {},
    parentCaseId: "parent",
    createdByAgentId: null,
    createdByUserId: null,
    completedAt: null,
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("CaseChildrenTree", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  function render(children: CaseSummary[]) {
    const root = createRoot(container);
    act(() => root.render(<CaseChildrenTree children={children} />));
    return root;
  }

  it("shows the empty state with no children", () => {
    const root = render([]);
    expect(container.textContent).toContain("No child cases");
    act(() => root.unmount());
  });

  it("renders each child with identifier, type and status chips linking to detail without keys", () => {
    const root = render([
      child({ identifier: "PAP-C8", key: "launch/post", caseType: "blog_post", status: "in_review", title: "Post" }),
      child({ identifier: "PAP-C9", caseType: "image", status: "done", title: "Hero image" }),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("PAP-C8");
    expect(text).not.toContain("launch/post");
    expect(text).toContain("blog_post");
    // StatusBadge renders the status with underscores as spaces.
    expect(text).toContain("in review");
    expect(text).toContain("Hero image");
    expect(container.querySelector('a[href="/PAP/cases/PAP-C8"]')).not.toBeNull();
    expect(container.querySelector('a[href="/PAP/cases/PAP-C9"]')).not.toBeNull();
    expect(container.querySelector('a[href="/PAP/cases/PAP-C8"]')?.className).not.toContain("border");
    act(() => root.unmount());
  });

  it("caps long child lists until show more is clicked", () => {
    const root = createRoot(container);
    const children = Array.from({ length: 7 }, (_, index) =>
      child({ id: `child-${index + 1}`, identifier: `PAP-C${index + 1}`, title: `Child ${index + 1}` })
    );
    act(() => root.render(<CaseChildrenTree children={children} maxVisible={5} />));

    expect(container.textContent).toContain("Child 5");
    expect(container.textContent).not.toContain("Child 6");
    expect(container.textContent).toContain("Show 2 more");

    const showMore = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Show 2 more")
    );
    expect(showMore).toBeTruthy();
    act(() => {
      showMore!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Child 6");
    expect(container.textContent).toContain("Child 7");
    expect(container.textContent).not.toContain("Show 2 more");
    act(() => root.unmount());
  });
});
