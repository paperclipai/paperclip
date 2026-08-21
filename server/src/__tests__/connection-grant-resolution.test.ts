import { describe, expect, it } from "vitest";
import {
  isConnectionGrantAudienceAllowed,
  resolveCredentialGrantKind,
} from "../services/tool-gateway.js";

describe("connection grant resolution", () => {
  it("resolves every credential policy deterministically", () => {
    expect(resolveCredentialGrantKind("shared", "alice", true)).toBe("organization");
    expect(resolveCredentialGrantKind("per_user", "alice", true)).toBe("user");
    expect(resolveCredentialGrantKind("per_user", "alice", false)).toBe("user_authorization_required");
    expect(resolveCredentialGrantKind("per_user", null, false)).toBe("user_authorization_required");
    expect(resolveCredentialGrantKind("per_user_with_fallback", "alice", true)).toBe("user");
    expect(resolveCredentialGrantKind("per_user_with_fallback", "alice", false)).toBe("organization");
    expect(resolveCredentialGrantKind("per_user_with_fallback", null, false)).toBe("organization");
  });

  it("allows an empty audience and rejects users outside a restricted audience", () => {
    expect(isConnectionGrantAudienceAllowed([], "alice")).toBe(true);
    expect(isConnectionGrantAudienceAllowed(["alice", "bob"], "alice")).toBe(true);
    expect(isConnectionGrantAudienceAllowed(["alice", "bob"], "carol")).toBe(false);
    expect(isConnectionGrantAudienceAllowed(["alice"], null)).toBe(false);
  });
});
