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

  it("accepts Apple Notes issue link URLs without allowing unsafe schemes", () => {
    expect(createIssueLinkSchema.parse({
      url: "https://www.icloud.com/notes/0123456789#SharedNote",
    })).toMatchObject({
      url: "https://www.icloud.com/notes/0123456789#SharedNote",
    });
    expect(createIssueLinkSchema.parse({
      url: "applenotes://showNote?identifier=ABCDEF",
    })).toMatchObject({
      url: "applenotes://showNote?identifier=ABCDEF",
    });
    expect(updateIssueLinkSchema.parse({
      url: "notes://showNote?identifier=ABCDEF",
    })).toMatchObject({
      url: "notes://showNote?identifier=ABCDEF",
    });

    expect(() => createIssueLinkSchema.parse({ url: "javascript:alert(1)" })).toThrow(/Apple Notes/);
    expect(() => createIssueLinkSchema.parse({ url: "file:///tmp/note.txt" })).toThrow(/Apple Notes/);
  });
});
