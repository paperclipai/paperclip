import { describe, expect, it } from "vitest";
import { wrapCommandWithEnv } from "../../src/pod-exec.js";

describe("wrapCommandWithEnv", () => {
  it("returns the command unchanged when there is no env", () => {
    expect(wrapCommandWithEnv(["opencode", "run"], undefined)).toEqual(["opencode", "run"]);
    expect(wrapCommandWithEnv(["opencode", "run"], {})).toEqual(["opencode", "run"]);
  });

  it("exports the env vars and execs the original command", () => {
    const out = wrapCommandWithEnv(
      ["opencode", "run", "--model", "anthropic/x"],
      { XDG_CONFIG_HOME: "/tmp/cfg", ANTHROPIC_API_KEY: "sk-bf-1" },
    );
    expect(out[0]).toBe("/bin/sh");
    expect(out[1]).toBe("-c");
    expect(out[2]).toContain("export XDG_CONFIG_HOME='/tmp/cfg';");
    expect(out[2]).toContain("export ANTHROPIC_API_KEY='sk-bf-1';");
    expect(out[2]).toContain("exec 'opencode' 'run' '--model' 'anthropic/x'");
  });

  it("never propagates PATH (would break command resolution in the sandbox image)", () => {
    const out = wrapCommandWithEnv(["opencode"], { PATH: "/server/bin", XDG_CONFIG_HOME: "/c" });
    expect(out[2]).not.toContain("PATH=");
    expect(out[2]).toContain("XDG_CONFIG_HOME=");
  });

  it("skips invalid identifiers and non-string values", () => {
    const out = wrapCommandWithEnv(["opencode"], {
      "BAD-KEY": "x",
      GOOD_KEY: "y",
      // @ts-expect-error intentional non-string to exercise the guard
      NUMERIC: 5,
    });
    expect(out[2]).toContain("export GOOD_KEY='y';");
    expect(out[2]).not.toContain("BAD-KEY");
    expect(out[2]).not.toContain("NUMERIC");
  });

  it("shell-escapes single quotes in values", () => {
    const out = wrapCommandWithEnv(["opencode"], { V: "a'b" });
    expect(out[2]).toContain("export V='a'\\''b';");
  });
});
