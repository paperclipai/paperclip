import { describe, it, expect } from "vitest";
import { microsoftShape } from "../microsoft.js";

describe("microsoftShape", () => {
  it("trims scope and splits on whitespace", () => {
    expect(
      microsoftShape.parseTokenResponse!({
        access_token: "T",
        expires_in: 3600,
        scope: "  Mail.Read  User.Read  ",
      }).scope,
    ).toEqual(["Mail.Read", "User.Read"]);
  });

  it("uses displayName + tenant id for account label", () => {
    expect(
      microsoftShape.parseAccountInfo!({
        id: "u-1",
        displayName: "Alice",
        tid: "tenant-x",
      }),
    ).toEqual({ accountId: "u-1", accountLabel: "Alice (tenant-x)" });
  });

  it("falls back to displayName-only when no tid", () => {
    expect(
      microsoftShape.parseAccountInfo!({ id: "u-1", displayName: "Alice" }),
    ).toEqual({ accountId: "u-1", accountLabel: "Alice" });
  });

  it("returns no label when displayName is absent", () => {
    expect(microsoftShape.parseAccountInfo!({ id: "u-1" })).toEqual({
      accountId: "u-1",
      accountLabel: undefined,
    });
  });

  it("throws when access_token is missing", () => {
    expect(() => microsoftShape.parseTokenResponse!({})).toThrow(
      /response_shape_violation/,
    );
  });

  it("throws when account id is missing", () => {
    expect(() => microsoftShape.parseAccountInfo!({})).toThrow(
      /response_shape_violation/,
    );
  });
});
