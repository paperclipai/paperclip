// @vitest-environment node

import { describe, expect, it } from "vitest";
import { shouldRenderRichSubIssuesSection } from "./issue-detail-subissues";

describe("shouldRenderRichSubIssuesSection", () => {
  it("shows the rich sub-issues section while child issues are loading", () => {
    expect(shouldRenderRichSubIssuesSection(true, 0)).toBe(true);
  });

  it("shows the rich sub-issues section when at least one child issue exists", () => {
    expect(shouldRenderRichSubIssuesSection(false, 1)).toBe(true);
  });

  it("hides the rich sub-issues section when there are no child issues", () => {
    expect(shouldRenderRichSubIssuesSection(false, 0)).toBe(false);
  });
});
