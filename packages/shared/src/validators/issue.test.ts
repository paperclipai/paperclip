import { describe, expect, it } from "vitest";
import { createIssueLinkSchema, updateIssueLinkSchema } from "./issue.js";

describe("issue link validators", () => {
  it("validates issue link create and update payloads", () => {
    expect(createIssueLinkSchema.parse({
      url: "  https://example.com/spec  ",
      title: "  Spec  ",
    })).toEqual({
      url: "https://example.com/spec",
      title: "Spec",
    });
    expect(updateIssueLinkSchema.parse({ title: null })).toEqual({ title: null });

    expect(() => createIssueLinkSchema.parse({ url: "ftp://example.com/spec" })).toThrow();
    expect(() => updateIssueLinkSchema.parse({})).toThrow();
  });
});
