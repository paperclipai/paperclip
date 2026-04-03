import { describe, expect, it } from "vitest";
import {
  normalizeInlineEditorValue,
  shouldSaveInlineEditorValue,
} from "./InlineEditor";

describe("InlineEditor save behavior", () => {
  it("trims values before saving", () => {
    expect(normalizeInlineEditorValue("  hello world  ")).toBe("hello world");
  });

  it("does not save when the normalized value is unchanged", () => {
    expect(shouldSaveInlineEditorValue("  hello  ", "hello")).toBe(false);
  });

  it("normalizes the current value before comparing", () => {
    expect(shouldSaveInlineEditorValue("hello", "  hello  ")).toBe(false);
  });

  it("saves when clearing an existing value", () => {
    expect(shouldSaveInlineEditorValue("", "Has description")).toBe(true);
    expect(shouldSaveInlineEditorValue("   ", "Has description")).toBe(true);
  });
});
