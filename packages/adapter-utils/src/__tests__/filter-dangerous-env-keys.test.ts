import { describe, it, expect } from "vitest";
import { filterDangerousEnvKeys } from "../server-utils.js";

describe("filterDangerousEnvKeys", () => {
  it("removes LD_PRELOAD", () => {
    const input = { FOO: "bar", LD_PRELOAD: "/evil.so" };
    const result = filterDangerousEnvKeys(input);
    expect(result).toEqual({ FOO: "bar" });
    expect(result).not.toHaveProperty("LD_PRELOAD");
  });

  it("removes NODE_OPTIONS", () => {
    const input = { ANTHROPIC_API_KEY: "sk-xxx", NODE_OPTIONS: "--require /evil.js" };
    const result = filterDangerousEnvKeys(input);
    expect(result).toEqual({ ANTHROPIC_API_KEY: "sk-xxx" });
  });

  it("removes all blocked keys", () => {
    const input = {
      LD_PRELOAD: "a",
      LD_LIBRARY_PATH: "b",
      DYLD_INSERT_LIBRARIES: "c",
      DYLD_LIBRARY_PATH: "d",
      DYLD_FRAMEWORK_PATH: "e",
      NODE_OPTIONS: "f",
      BASH_ENV: "g",
      ENV: "h",
      CDPATH: "i",
      PYTHONPATH: "j",
      PYTHONSTARTUP: "k",
      RUBYOPT: "l",
      PERL5OPT: "m",
      SAFE_KEY: "keep",
    };
    const result = filterDangerousEnvKeys(input);
    expect(result).toEqual({ SAFE_KEY: "keep" });
  });

  it("passes through safe keys unchanged", () => {
    const input = {
      ANTHROPIC_API_KEY: "sk-xxx",
      PATH: "/usr/bin",
      HOME: "/home/user",
      PAPERCLIP_API_KEY: "pk-xxx",
      CUSTOM_VAR: "value",
    };
    const result = filterDangerousEnvKeys(input);
    expect(result).toEqual(input);
  });

  it("returns empty object for empty input", () => {
    expect(filterDangerousEnvKeys({})).toEqual({});
  });

  it("returns empty object when all keys are blocked", () => {
    const input = { LD_PRELOAD: "a", NODE_OPTIONS: "b" };
    const result = filterDangerousEnvKeys(input);
    expect(result).toEqual({});
  });
});
