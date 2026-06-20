import { describe, expect, it } from "vitest";

import { stripInheritedOpenAiApiKey } from "./execute.js";

describe("stripInheritedOpenAiApiKey", () => {
  it("strips a host-level OPENAI_API_KEY when the adapter config omits it", () => {
    const effectiveEnv = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-host-leak",
      CODEX_HOME: "/tmp/codex-home",
    };
    const envConfig = { CODEX_HOME: "/tmp/codex-home" };

    const result = stripInheritedOpenAiApiKey(effectiveEnv, envConfig);

    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.PATH).toBe("/usr/bin");
    expect(result.CODEX_HOME).toBe("/tmp/codex-home");
  });

  it("preserves an explicitly configured non-empty OPENAI_API_KEY", () => {
    const effectiveEnv = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-explicit",
    };
    const envConfig = { OPENAI_API_KEY: "sk-explicit" };

    const result = stripInheritedOpenAiApiKey(effectiveEnv, envConfig);

    expect(result.OPENAI_API_KEY).toBe("sk-explicit");
  });

  it("preserves an explicitly configured empty OPENAI_API_KEY override", () => {
    // An explicit empty string is a deliberate blank-out of a host key. After
    // the env merge (`{ ...process.env, ...envConfigEnv }`) the empty config
    // value has already overridden the host value, so effectiveEnv carries
    // the empty string. The guard must NOT strip it, otherwise the host key
    // would leak back in via a re-merge on a later code path.
    const effectiveEnv = {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "",
    };
    const envConfig = { OPENAI_API_KEY: "" };

    const result = stripInheritedOpenAiApiKey(effectiveEnv, envConfig);

    expect(Object.prototype.hasOwnProperty.call(result, "OPENAI_API_KEY")).toBe(true);
    expect(result.OPENAI_API_KEY).toBe("");
  });

  it("does nothing when neither host nor config provides OPENAI_API_KEY", () => {
    const effectiveEnv = { PATH: "/usr/bin", CODEX_HOME: "/tmp/codex-home" };
    const envConfig = { CODEX_HOME: "/tmp/codex-home" };

    const result = stripInheritedOpenAiApiKey(effectiveEnv, envConfig);

    expect(Object.prototype.hasOwnProperty.call(result, "OPENAI_API_KEY")).toBe(false);
  });

  it("strips the inherited key when envConfig is empty", () => {
    const effectiveEnv = { OPENAI_API_KEY: "sk-host-leak" };
    const envConfig = {};

    const result = stripInheritedOpenAiApiKey(effectiveEnv, envConfig);

    expect(result.OPENAI_API_KEY).toBeUndefined();
  });

  it("mutates and returns the same effectiveEnv object reference", () => {
    const effectiveEnv = { OPENAI_API_KEY: "sk-host-leak" };
    const envConfig = {};

    const result = stripInheritedOpenAiApiKey(effectiveEnv, envConfig);

    expect(result).toBe(effectiveEnv);
  });
});