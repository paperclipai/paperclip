import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFile } from "../config-file.js";

// Minimal valid PaperclipConfig JSON that satisfies the schema.
const VALID_CONFIG = {
  $meta: { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", source: "onboard" },
  database: {},
  logging: { mode: "file" },
  server: {},
  telemetry: {},
};

describe("readConfigFile", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pclip-config-test-"));
    configPath = path.join(tmpDir, "config.json");
    // Point PAPERCLIP_CONFIG at the temp file location so readConfigFile uses it.
    process.env.PAPERCLIP_CONFIG = configPath;
  });

  afterEach(() => {
    delete process.env.PAPERCLIP_CONFIG;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("returns null when the config file does not exist", () => {
    // configPath was never written — file does not exist
    expect(readConfigFile()).toBeNull();
  });

  it("parses and returns a valid config file", () => {
    fs.writeFileSync(configPath, JSON.stringify(VALID_CONFIG));
    const result = readConfigFile();
    expect(result).not.toBeNull();
    expect(result?.logging.mode).toBe("file");
  });

  it("returns null for invalid JSON", () => {
    fs.writeFileSync(configPath, "{ not valid json ]]]");
    expect(readConfigFile()).toBeNull();
  });

  it("returns null when the JSON fails schema validation", () => {
    // logging.mode is required and must be 'file' or 'cloud'
    const badConfig = { ...VALID_CONFIG, logging: { mode: "invalid_mode" } };
    fs.writeFileSync(configPath, JSON.stringify(badConfig));
    expect(readConfigFile()).toBeNull();
  });

  it("returns null when a required top-level field is missing", () => {
    const { logging: _logging, ...withoutLogging } = VALID_CONFIG;
    fs.writeFileSync(configPath, JSON.stringify(withoutLogging));
    expect(readConfigFile()).toBeNull();
  });

  it("applies schema defaults for optional fields", () => {
    fs.writeFileSync(configPath, JSON.stringify(VALID_CONFIG));
    const result = readConfigFile();
    // telemetry.enabled defaults to true
    expect(result?.telemetry.enabled).toBe(true);
    // database.mode defaults to embedded-postgres
    expect(result?.database.mode).toBe("embedded-postgres");
  });
});
