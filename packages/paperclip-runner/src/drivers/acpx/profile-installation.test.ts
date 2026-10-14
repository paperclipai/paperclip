import { describe, expect, it } from "vitest";
import { assertAcpxProfileEnvironment, classifyAcpxProfileError } from "./profile-installation.js";

describe("Cursor actionable admission errors", () => {
  it("requires an explicit bound credential and supports both company-secret names", () => {
    expect(() => assertAcpxProfileEnvironment("cursor", {})).toThrow("Bind a company secret");
    expect(() => assertAcpxProfileEnvironment("cursor", { CURSOR_AUTH_TOKEN: " " })).toThrow();
    for (const key of ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]) expect(() => assertAcpxProfileEnvironment("cursor", { [key]: "fixture" })).not.toThrow();
    expect(() => assertAcpxProfileEnvironment("claude", {})).not.toThrow();
  });

  it.each([
    ["unauthorized: private-value", "CURSOR_AUTHENTICATION_FAILED"],
    ["model fixture is unavailable: private-value", "CURSOR_MODEL_UNAVAILABLE"],
    ["quota exceeded: private-value", "CURSOR_ENTITLEMENT_UNAVAILABLE"],
  ])("reports %s without echoing provider details or authorizing retries", (message, code) => {
    const result = classifyAcpxProfileError("cursor", new Error(message));
    expect(result).toMatchObject({ code, retryable: false });
    expect(result?.message).not.toContain("private-value");
  });

  it("preserves unrelated failures without inventing a provider diagnosis", () => {
    expect(classifyAcpxProfileError("cursor", new Error("filesystem is busy"))).toBeNull();
    expect(classifyAcpxProfileError("codex", new Error("unauthorized"))).toBeNull();
  });
});
