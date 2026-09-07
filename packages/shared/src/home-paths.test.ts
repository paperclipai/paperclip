import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveDefaultBackupDir,
  resolveDefaultEmbeddedPostgresDir,
  resolveDefaultLogsDir,
  resolveDefaultSecretsKeyFilePath,
  resolveDefaultStorageDir,
  resolveInstanceHealthToken,
  resolveDefaultHealthTokenPath,
  HEALTH_PROBE_TOKEN_HEADER,
  resolvePaperclipConfigPathForInstance,
  resolvePaperclipInstanceRoot,
} from "./home-paths.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("home path resolution", () => {
  it("resolves config and runtime data directly under the instance root", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-home-paths-"));
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    const instanceRoot = path.join(home, "instances", "default");
    expect(resolvePaperclipInstanceRoot()).toBe(instanceRoot);
    expect(resolvePaperclipConfigPathForInstance()).toBe(path.join(instanceRoot, "config.json"));
    expect(resolveDefaultEmbeddedPostgresDir()).toBe(path.join(instanceRoot, "db"));
    expect(resolveDefaultBackupDir()).toBe(path.join(instanceRoot, "data", "backups"));
    expect(resolveDefaultLogsDir()).toBe(path.join(instanceRoot, "logs"));
    expect(resolveDefaultStorageDir()).toBe(path.join(instanceRoot, "data", "storage"));
    expect(resolveDefaultSecretsKeyFilePath()).toBe(path.join(instanceRoot, "secrets", "master.key"));
  });

  it("resolves, generates, and persists health probe token", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-health-token-"));
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_INSTANCE_ID;

    expect(HEALTH_PROBE_TOKEN_HEADER).toBe("x-paperclip-health-token");
    const tokenPath = resolveDefaultHealthTokenPath();
    expect(tokenPath).toBe(path.join(home, "instances", "default", ".health-token"));

    const token = resolveInstanceHealthToken();
    expect(typeof token).toBe("string");
    expect(token?.length).toBe(64); // 32 hex bytes = 64 chars
    expect(fs.readFileSync(tokenPath, "utf8").trim()).toBe(token);

    // Reading again returns the exact same token
    const token2 = resolveInstanceHealthToken();
    expect(token2).toBe(token);

    // Env var override takes precedence
    process.env.PAPERCLIP_HEALTH_TOKEN = "custom-env-token";
    expect(resolveInstanceHealthToken()).toBe("custom-env-token");
  });
});
