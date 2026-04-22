import { describe, expect, it } from "vitest";
import { resolveProjectTab } from "./project-tabs";

describe("project tab routing", () => {
  it("resolves the source tab route", () => {
    expect(resolveProjectTab("/projects/paperclip-app/source", "paperclip-app")).toBe("source");
    expect(resolveProjectTab("/PAP/projects/paperclip-app/source", "paperclip-app")).toBe("source");
  });
});
