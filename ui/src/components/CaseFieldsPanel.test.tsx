// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CaseFieldsPanel } from "./CaseFieldsPanel";

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

describe("CaseFieldsPanel", () => {
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    container.remove();
  });

  function render(fields: Record<string, unknown>) {
    const root = createRoot(container);
    act(() => {
      root.render(<CaseFieldsPanel fields={fields} />);
    });
    return root;
  }

  it("shows the empty state when there are no fields", () => {
    const root = render({});
    expect(container.textContent).toContain("No fields set");
    act(() => root.unmount());
  });

  it("renders all four generic value types per spec", () => {
    const root = render({
      slug: "hermes-agent-post",
      word_count: 1850,
      published: true,
      draft_only: false,
      tags: ["ai", "launch"],
      publish_url: "https://example.com/post",
      related_case: "PAP-C12",
      missing: null,
      config: { nested: "x" },
    });

    // string
    expect(container.textContent).toContain("hermes-agent-post");
    // number — locale grouped, tabular
    expect(container.textContent).toContain("1,850");
    // string[] — chips
    expect(container.textContent).toContain("ai");
    expect(container.textContent).toContain("launch");
    // url → external link
    const urlLink = [...container.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === "https://example.com/post",
    );
    expect(urlLink).toBeTruthy();
    expect(urlLink?.getAttribute("target")).toBe("_blank");
    // case identifier → case link chip
    const caseLink = [...container.querySelectorAll("a")].find(
      (a) => a.getAttribute("href") === "/PAP/cases/PAP-C12",
    );
    expect(caseLink).toBeTruthy();
    // boolean never renders raw "true"/"false"
    expect(container.textContent).not.toContain("true");
    expect(container.textContent).not.toContain("false");
    // null → em-dash present
    expect(container.textContent).toContain("—");
    // object fallback → pretty-printed mono JSON block
    expect(container.textContent).toContain('"nested": "x"');
    // key insertion order preserved (slug before word_count)
    const text = container.textContent ?? "";
    expect(text.indexOf("slug")).toBeLessThan(text.indexOf("word_count"));

    act(() => root.unmount());
  });
});
