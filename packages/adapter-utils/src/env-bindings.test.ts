import { describe, expect, it } from "vitest";
import { buildAdapterEnvConfig, parseEnvBindings, parseEnvVars } from "./env-bindings.js";

describe("parseEnvBindings", () => {
  it("keeps plain, company secret, and user-scoped bindings", () => {
    const env = parseEnvBindings({
      PLAIN: { type: "plain", value: "on" },
      LEGACY_STRING: "raw",
      COMPANY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" },
      USER: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
    });

    expect(env).toEqual({
      PLAIN: { type: "plain", value: "on" },
      LEGACY_STRING: { type: "plain", value: "raw" },
      COMPANY: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111", version: "latest" },
      USER: { type: "user_secret_ref", key: "github_token", version: "latest", required: true },
    });
  });

  it("keeps a user-scoped binding without an optional version or required flag", () => {
    const env = parseEnvBindings({
      USER: { type: "user_secret_ref", key: "github_token" },
    });

    expect(env).toEqual({ USER: { type: "user_secret_ref", key: "github_token" } });
  });

  it("preserves allowMissingOverride when present", () => {
    const env = parseEnvBindings({
      USER: { type: "user_secret_ref", key: "k", allowMissingOverride: true },
    });

    expect(env.USER).toEqual({ type: "user_secret_ref", key: "k", allowMissingOverride: true });
  });

  it("drops invalid keys, unknown shapes, and incomplete refs", () => {
    const env = parseEnvBindings({
      "1BAD": { type: "plain", value: "x" },
      MISSING_KEY: { type: "user_secret_ref" },
      MISSING_ID: { type: "secret_ref" },
      UNKNOWN: { type: "mystery", value: "y" },
    });

    expect(env).toEqual({});
  });

  it("returns an empty map for non-object input", () => {
    expect(parseEnvBindings(null)).toEqual({});
    expect(parseEnvBindings([])).toEqual({});
    expect(parseEnvBindings("nope")).toEqual({});
  });
});

describe("parseEnvVars", () => {
  it("reads KEY=value lines and skips blanks, comments, and invalid keys", () => {
    // The key is trimmed; the value keeps every character after the first "=".
    const env = parseEnvVars("A=1\n# comment\n\nB = two = three\n1BAD=x\nNOEQ");

    expect(env).toEqual({ A: "1", B: " two = three" });
  });
});

describe("buildAdapterEnvConfig", () => {
  it("lets a structured binding win over a legacy plain-text entry with the same key", () => {
    const env = buildAdapterEnvConfig(
      { SHARED: { type: "user_secret_ref", key: "token" } },
      "SHARED=legacy\nONLY_LEGACY=x",
    );

    expect(env).toEqual({
      SHARED: { type: "user_secret_ref", key: "token" },
      ONLY_LEGACY: { type: "plain", value: "x" },
    });
  });

  it("tolerates missing legacy text", () => {
    expect(buildAdapterEnvConfig({ A: { type: "plain", value: "1" } }, undefined)).toEqual({
      A: { type: "plain", value: "1" },
    });
  });
});
