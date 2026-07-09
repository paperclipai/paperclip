import { describe, expect, it } from "vitest";

import { ApiError, formatApiError } from "./client";

// The server's error handler responds to a failed Zod parse with
// `{ error: "Validation error", details: err.errors }`. `err.errors` is the
// ZodIssue list — each issue carries `path` (segments) and `message`. These
// fixtures reproduce that wire shape so the test exercises the real payload the
// create-skill modal receives, without pulling zod into the ui package.
function validationApiError(details: Array<{ path: (string | number)[]; message: string }>): ApiError {
  return new ApiError("Validation error", 400, { error: "Validation error", details });
}

describe("formatApiError", () => {
  it("names the offending field instead of a bare 'Validation error'", () => {
    const error = validationApiError([
      { path: ["tagline"], message: "String must contain at most 120 character(s)" },
    ]);
    const message = formatApiError(error, "Failed to create skill.");
    expect(message).toContain("tagline");
    expect(message).toContain("120");
    expect(message).not.toBe("Validation error");
  });

  it("joins multiple field issues", () => {
    const error = validationApiError([
      { path: ["name"], message: "String must contain at least 1 character(s)" },
      { path: ["categories", 0], message: "String must contain at least 1 character(s)" },
    ]);
    const message = formatApiError(error);
    expect(message).toContain("name");
    expect(message).toContain("categories.0");
    expect(message).toContain(";");
  });

  it("falls back to the error message when there are no field details", () => {
    const error = new ApiError("Missing permission: can create agents", 403, {
      error: "Missing permission: can create agents",
    });
    expect(formatApiError(error)).toBe("Missing permission: can create agents");
  });

  it("uses the provided fallback for non-Error values", () => {
    expect(formatApiError(null, "Failed to create skill.")).toBe("Failed to create skill.");
  });
});
