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

  it("renders each child with identifier, type and status chips linking to detail", () => {
    const root = render([
      child({ identifier: "PAP-C8", caseType: "blog_post", status: "in_review", title: "Post" }),
      child({ identifier: "PAP-C9", caseType: "image", status: "done", title: "Hero image" }),
    ]);
    const text = container.textContent ?? "";
    expect(text).toContain("PAP-C8");
    expect(text).toContain("blog_post");
    // StatusBadge renders the status with underscores as spaces.
    expect(text).toContain("in review");
    expect(text).toContain("Hero image");
    expect(container.querySelector('a[href="/cases/PAP-C8"]')).not.toBeNull();
    expect(container.querySelector('a[href="/cases/PAP-C9"]')).not.toBeNull();
    act(() => root.unmount());
  });
});
