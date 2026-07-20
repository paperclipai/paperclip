import { describe, expect, it } from "vitest";
import { mergeInheritedCredentialEnv } from "../services/agent-credential-inheritance.js";

describe("mergeInheritedCredentialEnv (new agents inherit the company credential)", () => {
  const donorCred = { type: "secret_ref", secretId: "sec-1", version: "latest" };

  it("inherits a donor secret_ref the new agent does not have", () => {
    expect(mergeInheritedCredentialEnv({ CLAUDE_CODE_OAUTH_TOKEN: donorCred }, {})).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "sec-1", version: "latest" },
    });
  });

  it("never overrides an env key the request already set (even to a different value)", () => {
    const requested = { CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "own" } };
    expect(mergeInheritedCredentialEnv({ CLAUDE_CODE_OAUTH_TOKEN: donorCred }, requested)).toEqual(requested);
  });

  it("only inherits secret_ref bindings (ignores plain/string/non-secret env)", () => {
    const donorEnv = {
      CLAUDE_CODE_OAUTH_TOKEN: donorCred,
      SOME_FLAG: "plain-value",
      OTHER: { type: "plain", value: "x" },
    };
    expect(mergeInheritedCredentialEnv(donorEnv, {})).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "sec-1", version: "latest" },
    });
  });

  it("preserves projectionClass / projectionAllowlistKey / version verbatim", () => {
    const donorEnv = {
      ANTHROPIC_API_KEY: {
        type: "secret_ref",
        secretId: "sec-2",
        version: 3,
        projectionClass: "class3_static_lease",
        projectionAllowlistKey: "allow-abc",
      },
    };
    expect(mergeInheritedCredentialEnv(donorEnv, {})).toEqual({
      ANTHROPIC_API_KEY: {
        type: "secret_ref",
        secretId: "sec-2",
        version: 3,
        projectionClass: "class3_static_lease",
        projectionAllowlistKey: "allow-abc",
      },
    });
  });

  it("is a no-op when the donor has no secret_ref credentials", () => {
    expect(mergeInheritedCredentialEnv({ FLAG: "x" }, { EXISTING: { type: "secret_ref", secretId: "e" } })).toEqual({
      EXISTING: { type: "secret_ref", secretId: "e" },
    });
  });

  it("keeps the new agent's own env alongside inherited credentials", () => {
    const merged = mergeInheritedCredentialEnv(
      { CLAUDE_CODE_OAUTH_TOKEN: donorCred },
      { MY_VAR: { type: "plain", value: "keep" } },
    );
    expect(merged).toEqual({
      MY_VAR: { type: "plain", value: "keep" },
      CLAUDE_CODE_OAUTH_TOKEN: { type: "secret_ref", secretId: "sec-1", version: "latest" },
    });
  });
});
