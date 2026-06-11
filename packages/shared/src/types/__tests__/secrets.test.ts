import { describe, it, expect } from "vitest";
import type { EnvBinding, EnvOAuthTokenBinding } from "../secrets.js";

describe("EnvBinding union", () => {
  it("accepts oauth_token binding shape", () => {
    const binding: EnvOAuthTokenBinding = {
      type: "oauth_token",
      connectionId: "11111111-1111-1111-1111-111111111111",
      field: "access",
    };
    const asUnion: EnvBinding = binding;
    expect(typeof asUnion === "string" ? asUnion : asUnion.type).toBe(
      "oauth_token",
    );
  });
});
