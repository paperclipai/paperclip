import { describe, expect, it } from "vitest";
import { isClaudeUnknownSessionError } from "./parse.js";

describe("isClaudeUnknownSessionError", () => {
  it("detects the legacy 'no conversation found' message", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Error: No conversation found with session id 1234",
      }),
    ).toBe(true);
  });

  it("detects 'session ... not found' style errors", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: ["Session abc123 not found"],
      }),
    ).toBe(true);
  });

  it("detects '--resume requires a valid session' validation error from non-UUID input", () => {
    // Real CLI error when claude --resume is given a session ID in another adapter's
    // format (e.g. an opencode "ses_*" ID after switching adapters).
    expect(
      isClaudeUnknownSessionError({
        errors: [
          'Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_268c2d0a5ffemYbEaeG7c86Uvo" is not a UUID and does not match any session title.',
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated error text", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Some other failure",
        errors: ["Network timeout"],
      }),
    ).toBe(false);
  });
});
