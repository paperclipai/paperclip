import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveValadrienOsHomeDir,
  resolveValadrienOsInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.valadrien-os and default instance", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "valadrien-os-home-paths-"));
    process.env.VALADRIEN_OS_HOME = home;
    delete process.env.VALADRIEN_OS_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(home);
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(home, "instances", "default", "config.json"));
  });

  it("supports VALADRIEN_OS_HOME and explicit instance ids", () => {
    process.env.VALADRIEN_OS_HOME = "~/valadrien-os-home";

    const home = resolveValadrienOsHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "valadrien-os-home"));
    expect(resolveValadrienOsInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveValadrienOsInstanceId("bad/id")).toThrow(/Invalid VALADRIEN_OS_INSTANCE_ID/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
