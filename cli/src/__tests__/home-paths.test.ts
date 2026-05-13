import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  describeLocalInstancePaths,
  expandHomePrefix,
  resolveOdysseusHomeDir,
  resolveOdysseusInstanceId,
} from "../config/home.js";

const ORIGINAL_ENV = { ...process.env };

describe("home path resolution", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to ~/.odysseus and default instance", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "odysseus-home-paths-"));
    process.env.ODYSSEUS_HOME = home;
    delete process.env.ODYSSEUS_INSTANCE_ID;

    const paths = describeLocalInstancePaths();
    expect(paths.homeDir).toBe(home);
    expect(paths.instanceId).toBe("default");
    expect(paths.configPath).toBe(path.resolve(home, "instances", "default", "config.json"));
  });

  it("supports ODYSSEUS_HOME and explicit instance ids", () => {
    process.env.ODYSSEUS_HOME = "~/odysseus-home";

    const home = resolveOdysseusHomeDir();
    expect(home).toBe(path.resolve(os.homedir(), "odysseus-home"));
    expect(resolveOdysseusInstanceId("dev_1")).toBe("dev_1");
  });

  it("rejects invalid instance ids", () => {
    expect(() => resolveOdysseusInstanceId("bad/id")).toThrow(/Invalid ODYSSEUS_INSTANCE_ID/);
  });

  it("expands ~ prefixes", () => {
    expect(expandHomePrefix("~")).toBe(os.homedir());
    expect(expandHomePrefix("~/x/y")).toBe(path.resolve(os.homedir(), "x/y"));
  });
});
