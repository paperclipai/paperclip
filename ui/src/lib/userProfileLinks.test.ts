import { describe, expect, it } from "vitest";
import { userProfilePath } from "./userProfileLinks";

describe("userProfilePath", () => {
  it("links by user id even when a display name is available", () => {
    // Two members can share a name; the endpoint returns the first slug match,
    // so a name-based link could open a namesake's profile.
    expect(userProfilePath({ id: "user-1", name: "Jane Example", email: "jane@example.com" })).toBe("/u/user-1");
  });

  it("slugifies ids the same way the profile endpoint does", () => {
    expect(userProfilePath({ id: "paperclip-id:TLqGPuleJpjX" })).toBe("/u/paperclip-id-tlqgpulejpjx");
  });

  it("falls back to name, then email, when the session carries no id", () => {
    expect(userProfilePath({ id: null, name: "Jane Example", email: "jane@example.com" })).toBe("/u/jane-example");
    expect(userProfilePath({ id: "", name: "  ", email: "jane.doe@example.com" })).toBe("/u/jane-doe");
    expect(userProfilePath({ email: "@example.com" })).toBe("/u/example-com");
  });

  it("uses a placeholder when nothing identifies the user", () => {
    expect(userProfilePath(undefined)).toBe("/u/me");
    expect(userProfilePath({ id: "!!!", name: "'\"" })).toBe("/u/me");
  });
});
