// @vitest-environment node
//
// Regression protection suite.
// These tests run in node environment (not jsdom) because they read source
// files to verify fix invariants remain in place.
//
// Each test targets a specific past UI regression and verifies that the
// fix remains in place. When fixing a new UI regression, add a test here
// documenting the regression identifier and the invariant that must hold.
//
// Current regressions covered:
//   CRE-893 - Sort arrows using Unicode characters that fail to render in some fonts
//   CRE-964 - Sticky ID bar not hidden on mobile (breadcrumb overlap)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..");

// ---------------------------------------------------------------------------
// CRE-893: Sort arrows must use lucide-react SVG icons
//
// The initial implementation used Unicode escape sequences (\u2191 / \u2193)
// for the ascending/descending sort indicators in the issue list sort popover.
// These characters can fail to render in certain font environments, causing
// invisible or broken glyphs. The fix replaced them with lucide-react
// ArrowUp / ArrowDown SVG icons.
//
// This test verifies the component imports and uses SVG icon components
// rather than rendering raw text characters for sort direction indicators.
// ---------------------------------------------------------------------------
describe("CRE-893: sort arrows render as SVG icons", () => {
  it("imports ArrowUp and ArrowDown from lucide-react", () => {
    const sourcePath = resolve(__dirname, "../components/IssuesList.tsx");
    const source = readFileSync(sourcePath, "utf-8");

    const importMatch = source.match(/import\s+\{([^}]+)\}\s+from\s+["']lucide-react["']/);
    expect(importMatch).not.toBeNull();
    const importedNames = importMatch![1]!;
    expect(importedNames).toContain("ArrowUp");
    expect(importedNames).toContain("ArrowDown");

    expect(source).not.toContain("\\u2191");
    expect(source).not.toContain("\\u2193");
    expect(source).toContain("<ArrowUp");
    expect(source).toContain("<ArrowDown");

    const sortIndicatorRegex = /sortDir === "asc" \? <ArrowUp.*\/> : <ArrowDown.*\/>/;
    expect(sortIndicatorRegex.test(source)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CRE-964: Sticky ID bar must be hidden on mobile viewports
//
// The persistent issue identifier bar was added to remain visible when
// scrolling. However, it overlapped with the breadcrumb bar on mobile
// viewports. The fix applied responsive utility classes to hide it on mobile.
//
// This test verifies the sticky identifier bar div uses responsive classes
// that hide it on mobile (hidden md:block).
// ---------------------------------------------------------------------------
describe("CRE-964: sticky ID bar hidden on mobile", () => {
  it("sticky identifier bar uses hidden md:block responsive classes", () => {
    const sourcePath = resolve(__dirname, "../pages/IssueDetail.tsx");
    const source = readFileSync(sourcePath, "utf-8");

    const stickyBarRegex = /className="hidden md:block sticky top-0 z-10/;
    expect(stickyBarRegex.test(source)).toBe(true);

    expect(source).toContain("Persistent issue identifier bar");
  });
});

// ---------------------------------------------------------------------------
// Comment date binding regression: timeAgo must handle real date inputs
// that come from the server, returning valid relative time strings instead
// of "Invalid date".
// ---------------------------------------------------------------------------
describe("Comment date binding", () => {
  it("timeAgo function handles valid date strings", async () => {
    const { timeAgo } = await import("./timeAgo");
    const result = timeAgo(new Date().toISOString());
    expect(result).toBeTypeOf("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe("Invalid date");
  });
});
