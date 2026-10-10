import { describe, expect, it } from "vitest";
import {
  updateCompanyMemberWithPermissionsSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";

describe("access validators", () => {
  it("accepts HTTP(S) and Paperclip asset image URLs", () => {
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "https://example.com/avatar.png",
    }).success).toBe(true);
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "/api/assets/avatar/content",
    }).success).toBe(true);
  });

  it("rejects data URI profile images", () => {
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "data:image/png;base64,AAAA",
    }).success).toBe(false);
  });

  it("defaults omitted combined member grants to an empty list", () => {
    const result = updateCompanyMemberWithPermissionsSchema.parse({
      membershipRole: "operator",
    });

    expect(result.grants).toEqual([]);
  });
});
