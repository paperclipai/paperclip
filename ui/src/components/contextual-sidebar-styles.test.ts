import { describe, expect, it } from "vitest";
import { contextualSidebarStyles } from "./contextual-sidebar-styles";

describe("contextualSidebarStyles.section", () => {
  it("separates later sections with a margin and a top border", () => {
    const classes = contextualSidebarStyles.section.split(" ");
    expect(classes).toContain("mt-4");
    expect(classes).toContain("border-t");
  });

  it("removes the margin and border from the first section", () => {
    const classes = contextualSidebarStyles.section.split(" ");
    expect(classes).toContain("first:mt-0");
    expect(classes).toContain("first:border-t-0");
  });
});
