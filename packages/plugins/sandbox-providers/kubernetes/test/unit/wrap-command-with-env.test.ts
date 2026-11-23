import { spawnSync } from "node:child_process";
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

  it("skips the orchestrator's own PATH (would break command resolution in the sandbox image)", () => {
    const out = wrapCommandWithEnv(
      ["opencode"],
      { PATH: "/server/bin", XDG_CONFIG_HOME: "/c" },
      { hostPath: "/server/bin" },
    );
    expect(out[2]).not.toContain("PATH=");
    expect(out[2]).toContain("XDG_CONFIG_HOME=");
    const empty = wrapCommandWithEnv(["opencode"], { PATH: "", V: "x" }, { hostPath: "/server/bin" });
    expect(empty[2]).not.toContain("PATH=");
  });

  it("defaults hostPath to this process's PATH", () => {
    const out = wrapCommandWithEnv(["opencode"], { PATH: process.env.PATH ?? "", V: "x" });
    expect(out[2]).not.toContain("PATH=");
  });

  it("puts a sandbox PATH ahead of the image's PATH, keeping the image's entries", () => {
    const out = wrapCommandWithEnv(
      ["/bin/sh", "-c", 'printf "%s" "$PATH"'],
      { PATH: "/workspace/.launchers:/opt/it's" },
      { hostPath: "/server/bin" },
    );
    const [file, ...args] = out;
    const result = spawnSync(file!, args, { encoding: "utf-8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`/workspace/.launchers:/opt/it's:${process.env.PATH ?? ""}`);
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
