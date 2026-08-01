import { describe, expect, it } from "vitest";
import { trustAuthorizationPolicySchema } from "./trust-policy.js";

describe("trustAuthorizationPolicySchema assignmentPolicy", () => {
  it("accepts board_ui_create_only with a non-empty user allowlist", () => {
    expect(trustAuthorizationPolicySchema.parse({
      assignmentPolicy: {
        mode: "board_ui_create_only",
        allowedUserIds: ["owner-user"],
      },
    })).toEqual({
      assignmentPolicy: {
        mode: "board_ui_create_only",
        allowedUserIds: ["owner-user"],
      },
    });
  });

  it.each([
    { mode: "board_ui_create_only" },
    { mode: "board_ui_create_only", allowedUserIds: [] },
    { mode: "board_ui_create_only", allowedUserIds: [""] },
  ])("rejects malformed board_ui_create_only policy %#", (assignmentPolicy) => {
    expect(trustAuthorizationPolicySchema.safeParse({ assignmentPolicy }).success).toBe(false);
  });
});
