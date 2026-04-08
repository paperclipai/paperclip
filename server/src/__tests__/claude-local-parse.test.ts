import { describe, expect, it } from "vitest";
import { isClaudeSilentFailure } from "@paperclipai/adapter-claude-local/server";

/**
 * Unit tests for isClaudeSilentFailure.
 * @see https://github.com/paperclipai/paperclip/issues/3148
 */
describe("isClaudeSilentFailure", () => {
  it("returns true when is_error is boolean true", () => {
    expect(isClaudeSilentFailure({ is_error: true, result: "Credit balance is too low" })).toBe(true);
  });

  it("returns true when is_error is true regardless of subtype value", () => {
    expect(isClaudeSilentFailure({ is_error: true, subtype: "success" })).toBe(true);
    expect(isClaudeSilentFailure({ is_error: true, subtype: "error" })).toBe(true);
  });

  it("returns false when is_error is false", () => {
    expect(isClaudeSilentFailure({ is_error: false })).toBe(false);
  });

  it("returns false when is_error is absent", () => {
    expect(isClaudeSilentFailure({ result: "done", subtype: "success" })).toBe(false);
  });

  it("returns false when is_error is the string 'true' (strict equality)", () => {
    expect(isClaudeSilentFailure({ is_error: "true" })).toBe(false);
  });

  it("returns false for null input", () => {
    expect(isClaudeSilentFailure(null)).toBe(false);
  });

  it("returns false for undefined input", () => {
    expect(isClaudeSilentFailure(undefined)).toBe(false);
  });
});
