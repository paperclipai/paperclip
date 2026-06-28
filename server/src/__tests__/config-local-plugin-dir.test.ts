import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";

// Pin config resolution at a path that does not exist so loadConfig() ignores any
// ambient config.json and resolves purely from env + defaults. This keeps the test
// hermetic regardless of the cwd the suite runs from.
const NONEXISTENT_CONFIG = path.join(os.tmpdir(), "paperclip-no-such-config-xyz", "config.json");

const MANAGED_KEYS = [
  "PAPERCLIP_CONFIG",
  "PAPERCLIP_LOCAL_PLUGIN_DIR",
  "PAPERCLIP_DEPLOYMENT_MODE",
  "PAPERCLIP_BIND",
  "HOST",
] as const;
const SAVED: Record<string, string | undefined> = Object.fromEntries(
  MANAGED_KEYS.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
  process.env.PAPERCLIP_CONFIG = NONEXISTENT_CONFIG;
  // Pin a valid, deterministic bind combination so the test is independent of the
  // ambient host env (e.g. PAPERCLIP_LISTEN_HOST / a detected tailnet address).
  process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
  process.env.PAPERCLIP_BIND = "loopback";
  process.env.HOST = "127.0.0.1";
  delete process.env.PAPERCLIP_LOCAL_PLUGIN_DIR;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("config localPluginDir override", () => {
  it("defaults to undefined so the server keeps DEFAULT_LOCAL_PLUGIN_DIR", () => {
    expect(loadConfig().localPluginDir).toBeUndefined();
  });

  it("honors PAPERCLIP_LOCAL_PLUGIN_DIR as an absolute path", () => {
    process.env.PAPERCLIP_LOCAL_PLUGIN_DIR = "/srv/paperclip-beta/plugins";
    expect(loadConfig().localPluginDir).toBe("/srv/paperclip-beta/plugins");
  });

  it("expands a ~ home-prefixed override", () => {
    process.env.PAPERCLIP_LOCAL_PLUGIN_DIR = "~/.paperclip/instances/beta/plugins";
    expect(loadConfig().localPluginDir).toBe(
      path.resolve(os.homedir(), ".paperclip/instances/beta/plugins"),
    );
  });
});
