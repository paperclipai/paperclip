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

    // For file-backed instances, the token on disk is canonical and prevents divergence
    // from a caller-local environment variable
    process.env.PAPERCLIP_HEALTH_TOKEN = "divergent-env-token";
    expect(resolveInstanceHealthToken()).toBe(token);
  });

  it("initializes token from PAPERCLIP_HEALTH_TOKEN when no token file exists", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-env-token-"));
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HEALTH_TOKEN = "custom-env-token";

    const token = resolveInstanceHealthToken();
    expect(token).toBe("custom-env-token");

    const tokenPath = resolveDefaultHealthTokenPath();
    expect(fs.readFileSync(tokenPath, "utf8").trim()).toBe("custom-env-token");
  });

  it("prevents race conditions during concurrent first-use token initialization", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-concurrent-token-"));
    process.env.PAPERCLIP_HOME = home;
    delete process.env.PAPERCLIP_INSTANCE_ID;
    delete process.env.PAPERCLIP_HEALTH_TOKEN;

    const tokenPath = resolveDefaultHealthTokenPath();
    expect(fs.existsSync(tokenPath)).toBe(false);

    // Simulate 20 concurrent first-use callers initializing the token at the same time
    const results = await Promise.all(
      Array.from({ length: 20 }, () => Promise.resolve().then(() => resolveInstanceHealthToken())),
    );

    const firstToken = results[0];
    expect(typeof firstToken).toBe("string");
    expect(firstToken?.length).toBe(64);

    // Every concurrent caller must receive the exact same token
    for (const token of results) {
      expect(token).toBe(firstToken);
    }

    // The token persisted on disk must match the token returned to all callers
    expect(fs.readFileSync(tokenPath, "utf8").trim()).toBe(firstToken);
  });
});
