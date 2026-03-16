import { describe, expect, it } from "vitest";
import {
  buildProjectMentionHref,
  extractProjectMentionIds,
  parseProjectMentionHref,
} from "./project-mentions.js";

describe("project mention helpers", () => {
  it("normalizes short hex colors when building and parsing mention links", () => {
    const href = buildProjectMentionHref("project-123", "#abc");

    expect(href).toBe("project://project-123?c=aabbcc");
    expect(parseProjectMentionHref(href)).toEqual({
      projectId: "project-123",
      color: "#aabbcc",
    });
  });

  it("extracts unique project IDs from markdown links only", () => {
    const markdown = [
      "[Alpha](project://alpha?c=112233)",
      "[Alpha again](project://alpha?c=abc)",
      "[Beta](project://beta)",
      "[Ignore](https://example.com/project://not-a-project)",
    ].join("\n");

    expect(extractProjectMentionIds(markdown)).toEqual(["alpha", "beta"]);
  });

  it("ignores invalid project mention URLs", () => {
    expect(parseProjectMentionHref("https://example.com/projects/123")).toBeNull();
    expect(parseProjectMentionHref("project://")).toBeNull();
  });
});
