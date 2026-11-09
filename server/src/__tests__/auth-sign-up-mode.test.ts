import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAuthSignUpMode } from "../auth/sign-up-mode.js";
import { loadConfig } from "../config.js";

const unset = {
  envSignUp: undefined,
  envDisableSignUp: undefined,
  fileSignUp: undefined,
  fileDisableSignUp: undefined,
};

describe("resolveAuthSignUpMode", () => {
  it("defaults to open", () => {
    expect(resolveAuthSignUpMode(unset)).toBe("open");
  });

  it.each(["open", "invite", "disabled"] as const)("reads %s from PAPERCLIP_AUTH_SIGN_UP", (mode) => {
    expect(resolveAuthSignUpMode({ ...unset, envSignUp: mode })).toBe(mode);
  });

  it("trims and lower-cases the env value", () => {
    expect(resolveAuthSignUpMode({ ...unset, envSignUp: "  Invite " })).toBe("invite");
  });

  it("rejects an unknown env value instead of falling back to open sign-up", () => {
    expect(() => resolveAuthSignUpMode({ ...unset, envSignUp: "invites" })).toThrow(
      /PAPERCLIP_AUTH_SIGN_UP must be one of open, invite, disabled/,
    );
  });

  it("ignores an empty env value", () => {
    expect(resolveAuthSignUpMode({ ...unset, envSignUp: "  ", fileSignUp: "invite" })).toBe("invite");
  });

  it("reads auth.signUp from the config file", () => {
    expect(resolveAuthSignUpMode({ ...unset, fileSignUp: "invite" })).toBe("invite");
  });

  it("prefers the env setting over the file setting", () => {
    expect(resolveAuthSignUpMode({ ...unset, envSignUp: "disabled", fileSignUp: "invite" })).toBe("disabled");
  });

  it("keeps the legacy flags working when the new setting is absent", () => {
    expect(resolveAuthSignUpMode({ ...unset, envDisableSignUp: "true" })).toBe("disabled");
    expect(resolveAuthSignUpMode({ ...unset, envDisableSignUp: "false" })).toBe("open");
    expect(resolveAuthSignUpMode({ ...unset, fileDisableSignUp: true })).toBe("disabled");
    expect(resolveAuthSignUpMode({ ...unset, fileDisableSignUp: false })).toBe("open");
  });

  it("lets the legacy env flag override the legacy file flag, as before", () => {
    expect(resolveAuthSignUpMode({ ...unset, envDisableSignUp: "false", fileDisableSignUp: true })).toBe("open");
    expect(resolveAuthSignUpMode({ ...unset, envDisableSignUp: "true", fileDisableSignUp: false })).toBe("disabled");
  });

  it("lets the new setting win over the legacy flags from any source", () => {
    expect(
      resolveAuthSignUpMode({ ...unset, fileSignUp: "invite", envDisableSignUp: "true", fileDisableSignUp: true }),
    ).toBe("invite");
    expect(resolveAuthSignUpMode({ ...unset, envSignUp: "open", envDisableSignUp: "true" })).toBe("open");
  });
});

describe("loadConfig sign-up mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads PAPERCLIP_AUTH_SIGN_UP", () => {
    vi.stubEnv("PAPERCLIP_AUTH_SIGN_UP", "invite");
    vi.stubEnv("PAPERCLIP_AUTH_DISABLE_SIGN_UP", "true");
    expect(loadConfig().authSignUpMode).toBe("invite");
  });

  it("maps the legacy PAPERCLIP_AUTH_DISABLE_SIGN_UP=true to disabled", () => {
    vi.stubEnv("PAPERCLIP_AUTH_SIGN_UP", "");
    vi.stubEnv("PAPERCLIP_AUTH_DISABLE_SIGN_UP", "true");
    expect(loadConfig().authSignUpMode).toBe("disabled");
  });
});
