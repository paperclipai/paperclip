import { describe, expect, it } from "vitest";
import { requireServerAdapter } from "../adapters/registry.js";
import {
  deriveLoginSessionHome,
  isLoginCommandKey,
  isLoginCommandSupportedAdapterType,
  LOGIN_SESSION_HOME_ROOT,
  resolveLoginCommandKey,
  validateLoginSessionHome,
} from "./login-command.js";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("resolveLoginCommandKey", () => {
  it("resolves the trusted adapter type to the closed key", () => {
    expect(resolveLoginCommandKey("claude_local")).toBe("claude");
    expect(resolveLoginCommandKey("codex_local")).toBe("codex");
    expect(resolveLoginCommandKey("grok_local")).toBe("grok");
  });

  it("fails closed for an unmapped adapter type", () => {
    // The provider driver key and an unknown adapter confer no command authority.
    expect(() => resolveLoginCommandKey("daytona")).toThrow("LOGIN_PTY_UNSUPPORTED_ADAPTER");
    expect(() => resolveLoginCommandKey("gemini_local")).toThrow("LOGIN_PTY_UNSUPPORTED_ADAPTER");
    expect(() => resolveLoginCommandKey("")).toThrow("LOGIN_PTY_UNSUPPORTED_ADAPTER");
  });

  it("stays grok when the registered adapter's own getCommand member changes", () => {
    // Condition 4: the login path selects the command key from this closed map
    // only, never from the adapter's own login capability. Mutating the
    // registered `grok_local` capability's `getCommand` member must not change
    // the key this function returns for the same adapter type.
    const capability = requireServerAdapter("grok_local").loginCapability;
    expect(capability).toBeDefined();
    if (!capability) return;
    const original = capability.getCommand;
    capability.getCommand = () => "rm -rf /";
    try {
      expect(resolveLoginCommandKey("grok_local")).toBe("grok");
    } finally {
      capability.getCommand = original;
    }
  });
});

describe("isLoginCommandKey", () => {
  it("accepts only the closed key set", () => {
    expect(isLoginCommandKey("claude")).toBe(true);
    expect(isLoginCommandKey("codex")).toBe(true);
    expect(isLoginCommandKey("grok")).toBe(true);
    expect(isLoginCommandKey("gemini")).toBe(false);
    expect(isLoginCommandKey("rm -rf /")).toBe(false);
    expect(isLoginCommandKey(undefined)).toBe(false);
  });
});

describe("isLoginCommandSupportedAdapterType", () => {
  it("accepts only the adapter types the closed command map holds", () => {
    // The admission guard reads this predicate, so it must match the map that
    // the opener resolves. The mapped types pass; an unmapped type fails closed.
    expect(isLoginCommandSupportedAdapterType("claude_local")).toBe(true);
    expect(isLoginCommandSupportedAdapterType("codex_local")).toBe(true);
    expect(isLoginCommandSupportedAdapterType("grok_local")).toBe(true);
    expect(isLoginCommandSupportedAdapterType("gemini_local")).toBe(false);
    expect(isLoginCommandSupportedAdapterType("daytona")).toBe(false);
    expect(isLoginCommandSupportedAdapterType("")).toBe(false);
  });
});

describe("deriveLoginSessionHome", () => {
  it("derives the exact UUID-form absolute path", () => {
    expect(deriveLoginSessionHome(UUID)).toBe(`${LOGIN_SESSION_HOME_ROOT}/${UUID}`);
  });

  it("rejects a non-UUID id", () => {
    expect(() => deriveLoginSessionHome("not-a-uuid")).toThrow("LOGIN_PTY_INVALID_SESSION_HOME");
    expect(() => deriveLoginSessionHome("")).toThrow("LOGIN_PTY_INVALID_SESSION_HOME");
  });
});

describe("validateLoginSessionHome", () => {
  it("accepts the exact derived path shape", () => {
    expect(() => validateLoginSessionHome(`${LOGIN_SESSION_HOME_ROOT}/${UUID}`)).not.toThrow();
  });

  it("rejects an empty, relative, traversal, whitespace, control, or metacharacter candidate", () => {
    const candidates = [
      "",
      "paperclip-adapter-login/" + UUID,
      `${LOGIN_SESSION_HOME_ROOT}/../${UUID}`,
      `${LOGIN_SESSION_HOME_ROOT}/${UUID}/..`,
      `${LOGIN_SESSION_HOME_ROOT}/ ${UUID}`,
      `${LOGIN_SESSION_HOME_ROOT}/${UUID} `,
      `${LOGIN_SESSION_HOME_ROOT}/${UUID}\n`,
      `${LOGIN_SESSION_HOME_ROOT}/${UUID}\t`,
      `${LOGIN_SESSION_HOME_ROOT}/${UUID}\0`,
      `${LOGIN_SESSION_HOME_ROOT}/${UUID};rm -rf /`,
      `${LOGIN_SESSION_HOME_ROOT}/$(id)`,
      `${LOGIN_SESSION_HOME_ROOT}/${UUID}&&whoami`,
      `/tmp/other/${UUID}`,
      `${LOGIN_SESSION_HOME_ROOT}/NOTHEX11-2222-4333-8444-555555555555`,
    ];
    for (const candidate of candidates) {
      expect(() => validateLoginSessionHome(candidate), candidate).toThrow(
        "LOGIN_PTY_INVALID_SESSION_HOME",
      );
    }
  });
});
