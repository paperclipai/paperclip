// @vitest-environment node

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusGlyph } from "./StatusGlyph";

describe("StatusGlyph", () => {
  it("animates in_review while a live run continues, keeps it static otherwise", () => {
    expect(renderToStaticMarkup(<StatusGlyph status="in_review" />).includes("motion-safe:animate-spin")).toBe(false);
    const live = renderToStaticMarkup(<StatusGlyph status="in_review" live />);
    // Open-arc spinner so rotation is visible (a spinning CircleDot is not).
    expect(live.includes("motion-safe:animate-spin")).toBe(true);
    expect(live).toContain("lucide-task-progress-spinner");
    expect(live).toContain("var(--status-task-icon-in_review)");
    expect(renderToStaticMarkup(<StatusGlyph status="in_progress" live />).includes("motion-safe:animate-spin")).toBe(true);
    expect(renderToStaticMarkup(<StatusGlyph status="todo" live />).includes("motion-safe:animate-spin")).toBe(false);
  });
});
