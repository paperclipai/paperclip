import { describe, expect, it } from "vitest";
import {
  updateAgentGrantsSchema,
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

  it("accepts agent grant payloads with valid keys and passes scope through", () => {
    const result = updateAgentGrantsSchema.parse({
      grants: [
        { permissionKey: "agents:configure" },
        { permissionKey: "tasks:assign", scope: { projectId: "project-1" } },
        { permissionKey: "tools:use", scope: null },
      ],
    });

    expect(result.grants).toHaveLength(3);
    expect(result.grants[1]).toEqual({
      permissionKey: "tasks:assign",
      scope: { projectId: "project-1" },
    });
    expect(result.grants[2]).toEqual({ permissionKey: "tools:use", scope: null });
  });

  it("rejects agent grant payloads with unknown permission keys", () => {
    expect(
      updateAgentGrantsSchema.safeParse({
        grants: [{ permissionKey: "not:a:key" }],
      }).success,
    ).toBe(false);
  });

  it("rejects agent grant payloads with non-object scopes", () => {
    expect(
      updateAgentGrantsSchema.safeParse({
        grants: [{ permissionKey: "tools:use", scope: "project-1" }],
      }).success,
    ).toBe(false);
  });
});
