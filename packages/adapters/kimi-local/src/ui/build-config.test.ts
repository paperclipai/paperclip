import { describe, expect, it } from "vitest";
import { buildKimiLocalConfig } from "./build-config.js";

describe("buildKimiLocalConfig", () => {
  it("produces default config", () => {
    const config = buildKimiLocalConfig({
      cwd: "/workspace",
      instructionsFilePath: "/workspace/AGENTS.md",
      model: "kimi-k2.5",
    } as never);
    expect(config).toMatchObject({
      cwd: "/workspace",
      instructionsFilePath: "/workspace/AGENTS.md",
      model: "kimi-k2.5",
      timeoutSec: 0,
      graceSec: 20,
    });
  });

  it("parses extraArgs as comma-separated list", () => {
    const config = buildKimiLocalConfig({
      extraArgs: "--flag1, --flag2",
    } as never);
    expect(config.extraArgs).toEqual(["--flag1", "--flag2"]);
  });

  it("includes env bindings", () => {
    const config = buildKimiLocalConfig({
      envBindings: {
        FOO: { type: "plain", value: "bar" },
      },
    } as never);
    expect(config.env).toEqual({
      FOO: { type: "plain", value: "bar" },
    });
  });
});
