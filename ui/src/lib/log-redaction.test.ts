import { describe, expect, it } from "vitest";
import { redactOperatorFacingText, redactOperatorFacingUnknown } from "./log-redaction";

describe("operator-facing log redaction", () => {
  it("redacts the current user label and home path while keeping context readable", () => {
    const value = "user-123 ran /Users/pedro/project and /Users/pedro/project/file.ts";
    expect(
      redactOperatorFacingText(value, {
        currentUserId: "user-123",
      }),
    ).toBe("current user ran ~/project and ~/project/file.ts");
  });

  it("redacts nested object and array content recursively", () => {
    expect(
      redactOperatorFacingUnknown(
        {
          path: "/Users/pedro/project",
          nested: ["user-123", { cwd: "/Users/pedro/project/file.ts" }],
        },
        {
          currentUserId: "user-123",
        },
      ),
    ).toEqual({
      path: "~/project",
      nested: ["current user", { cwd: "~/project/file.ts" }],
    });
  });
});
