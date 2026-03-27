import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveIronworksHomeDir,
  resolveIronworksInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.ironworks and default instance", () => {
    delete process.env.IRONWORKS_HOME;
    delete process.env.IRONWORKS_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(path.resolve(os.homedir(), ".ironworks"));
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(os.homedir(), ".ironworks", "instances", "default", "config.json"));
  });

  it("supports IRONWORKS_HOME and explicit instance ids", () => {
    process.env.IRONWORKS_HOME = "~/ironworks-home";

    const home = resolveIronworksHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "ironworks-home"));
    expect(resolveIronworksInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveIronworksInstanceId("bad/id")).toThrow(/Invalid instance id/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
