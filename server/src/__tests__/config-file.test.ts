import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfigFile } from "../config-file.js";

describe("readConfigFile", () => {
  let tempDir: string;
  let originalConfigPath: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-config-file-"));
    originalConfigPath = process.env.PAPERCLIP_CONFIG;
    process.env.PAPERCLIP_CONFIG = path.join(tempDir, "config.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalConfigPath === undefined) {
      delete process.env.PAPERCLIP_CONFIG;
    } else {
      process.env.PAPERCLIP_CONFIG = originalConfigPath;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when the resolved config file does not exist", () => {
    expect(readConfigFile()).toBeNull();
  });

  it("throws a safe path-aware error when an existing config cannot be read", () => {
    const configPath = process.env.PAPERCLIP_CONFIG!;
    fs.writeFileSync(configPath, '{"secret":"do-not-leak"}');
    const readError = new Error("permission denied: do-not-leak") as NodeJS.ErrnoException;
    readError.code = "EACCES";
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw readError;
    });

    let thrown: unknown;
    try {
      readConfigFile();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain(`Failed to read Paperclip config at ${configPath}`);
    expect(String(thrown)).not.toContain("do-not-leak");
    expect((thrown as Error).cause).toBeUndefined();
  });

  it("throws a safe path-aware error for malformed JSON", () => {
    const configPath = process.env.PAPERCLIP_CONFIG!;
    fs.writeFileSync(configPath, '{"secret":"do-not-leak"');

    expect(() => readConfigFile()).toThrow(`Invalid JSON in Paperclip config at ${configPath}`);
    try {
      readConfigFile();
    } catch (error) {
      expect(String(error)).not.toContain("do-not-leak");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("throws a safe path-aware error for schema-invalid config", () => {
    const configPath = process.env.PAPERCLIP_CONFIG!;
    fs.writeFileSync(configPath, JSON.stringify({ secret: "do-not-leak" }));

    expect(() => readConfigFile()).toThrow(
      `Invalid Paperclip config schema at ${configPath}`,
    );
    try {
      readConfigFile();
    } catch (error) {
      expect(String(error)).not.toContain("do-not-leak");
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it("returns a parsed valid config", () => {
    fs.writeFileSync(
      process.env.PAPERCLIP_CONFIG!,
      JSON.stringify({
        $meta: {
          version: 1,
          updatedAt: "2026-07-18T00:00:00.000Z",
          source: "configure",
        },
        database: { mode: "embedded-postgres" },
        logging: { mode: "file" },
        server: {},
      }),
    );

    expect(readConfigFile()).toMatchObject({
      $meta: { version: 1 },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file" },
    });
  });
});
