import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveAiTeamCorpHomeDir,
  resolveAiTeamCorpInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.aiteamcorp and default instance", () => {
    delete process.env.AITEAMCORP_HOME;
    delete process.env.AITEAMCORP_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(path.resolve(os.homedir(), ".aiteamcorp"));
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(os.homedir(), ".aiteamcorp", "instances", "default", "config.json"));
  });

  it("supports AITEAMCORP_HOME and explicit instance ids", () => {
    process.env.AITEAMCORP_HOME = "~/aiteamcorp-home";

    const home = resolveAiTeamCorpHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "aiteamcorp-home"));
    expect(resolveAiTeamCorpInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveAiTeamCorpInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
