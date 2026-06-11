import { describe, it, expect } from "vitest";
import { buildDefaultShape } from "../default-shape.js";

const cfg = {
  accountIdField: "id",
  accountLabelField: "login",
} as const;

describe("buildDefaultShape", () => {
  const shape = buildDefaultShape(cfg);

  it("parses RFC-6749 token response", () => {
    expect(
      shape.parseTokenResponse!({
        access_token: "abc",
        refresh_token: "def",
        expires_in: 3600,
        scope: "repo user",
      }),
    ).toEqual({
      accessToken: "abc",
      refreshToken: "def",
      expiresInSeconds: 3600,
      scope: ["repo", "user"],
    });
  });

  it("parses account info via configured fields", () => {
    expect(shape.parseAccountInfo!({ id: 42, login: "octocat" })).toEqual({
      accountId: "42",
      accountLabel: "octocat",
    });
  });

  it("rejects missing access_token", () => {
    expect(() => shape.parseTokenResponse!({})).toThrow();
  });

  it("rejects negative expires_in", () => {
    expect(() => shape.parseTokenResponse!({ access_token: "x", expires_in: -1 })).toThrow();
  });

  it("rejects expires_in over a year", () => {
    expect(() =>
      shape.parseTokenResponse!({ access_token: "x", expires_in: 60_000_000 }),
    ).toThrow();
  });

  it("rejects non-string account id", () => {
    expect(() => shape.parseAccountInfo!({ id: { nested: 1 }, login: "x" })).toThrow();
  });
});
