// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThreadAttachments, ThreadWorkProduct } from "./Thread";
import { testArtifact } from "./test-artifact";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const files = (count: number) =>
  Array.from({ length: count }, (_, i) => testArtifact({ kind: "pdf", id: `pdf-${i}`, filename: `deck-${i}.pdf`, sizeLabel: "57.7 KB" }));

describe("the thread's artifact rows", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders a work product as one full-width row named after its file", () => {
    act(() => root.render(<ThreadWorkProduct artifact={files(1)[0]} />));
    const button = container.querySelector("button");
    expect(button?.getAttribute("aria-label")).toBe("Open deck-0.pdf");
    expect(container.querySelector('[data-surface="thread"]')).toBeNull();
    expect(button?.textContent).toContain("57.7 KB");
  });

  it("renders one attachment as a single row, with no group around it", () => {
    act(() => root.render(<ThreadAttachments artifacts={files(1)} />));
    expect(container.querySelectorAll("button")).toHaveLength(1);
    expect(container.querySelector('[data-surface="thread"]')).toBeNull();
  });

  it("groups several attachments inline at equal widths that wrap past 280px each", () => {
    act(() => root.render(<ThreadAttachments artifacts={files(5)} />));
    const group = container.querySelector<HTMLElement>('[data-surface="thread"]');
    expect(group?.className).toContain("flex-wrap");
    const rows = Array.from(group?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.style.flex).toBe("1 0 280px");
      expect(row.className).toContain("min-w-px");
    }
  });

  it("renders nothing for an empty attachments block", () => {
    act(() => root.render(<ThreadAttachments artifacts={[]} />));
    expect(container.innerHTML).toBe("");
  });
});
