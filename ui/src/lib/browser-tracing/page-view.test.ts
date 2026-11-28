import { describe, expect, it } from "vitest";
import { TASK_VIEW_KEYS } from "@/lib/task-views";
import { pageViewFor } from "./page-view";

describe("pageViewFor", () => {
  it("reports the all-tasks page's view from ?view=", () => {
    expect(pageViewFor("/:companyPrefix/issues", "?view=mine")).toBe("mine");
    expect(pageViewFor("/:companyPrefix/issues", "?q=secret&view=needs_attention")).toBe("needs_attention");
    for (const key of TASK_VIEW_KEYS) expect(pageViewFor("/:companyPrefix/issues", `?view=${key}`)).toBe(key);
  });

  it("never reports free text: an unknown view becomes other", () => {
    expect(pageViewFor("/:companyPrefix/issues", "?view=PAP-1234")).toBe("other");
    expect(pageViewFor("/:companyPrefix/issues", "?view=someone%40example.com")).toBe("other");
    expect(pageViewFor("/:companyPrefix/decisions", "?view=mine%20x")).toBe("other");
  });

  it("reports the page's default when the URL names no view", () => {
    expect(pageViewFor("/:companyPrefix/issues", "")).toBe("default");
    expect(pageViewFor("/:companyPrefix/decisions", "?other=1")).toBe("mine");
    expect(pageViewFor("/:companyPrefix/decisions", "?view=unassigned")).toBe("unassigned");
  });

  it("reports nothing for a page without views", () => {
    expect(pageViewFor("/:companyPrefix/issues/:issueId", "?view=mine")).toBeNull();
    expect(pageViewFor("/:companyPrefix/skills", "?view=catalog")).toBeNull();
  });
});
