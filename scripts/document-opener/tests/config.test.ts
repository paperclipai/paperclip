import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, DEFAULT_PORT, DEFAULT_ALLOWED_ORIGINS } from "../src/config";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "doc-opener-cfg-"));
  });

  it("returns null when the config file does not exist", () => {
    const result = loadConfig(join(tmpDir, "missing.json"));
    expect(result).toBeNull();
  });

  it("returns null when the config file is malformed JSON", () => {
    const path = join(tmpDir, "bad.json");
    writeFileSync(path, "{ not json");
    const result = loadConfig(path);
    expect(result).toBeNull();
  });

  it("returns null when roots field is missing", () => {
    const path = join(tmpDir, "noroots.json");
    writeFileSync(path, JSON.stringify({ port: 19327 }));
    const result = loadConfig(path);
    expect(result).toBeNull();
  });

  it("returns null when roots is empty array", () => {
    const path = join(tmpDir, "empty.json");
    writeFileSync(path, JSON.stringify({ roots: [] }));
    const result = loadConfig(path);
    expect(result).toBeNull();
  });

  it("loads valid config with all fields", () => {
    const path = join(tmpDir, "ok.json");
    const data = {
      port: 12345,
      roots: ["/Users/foo", "~/bar"],
      allowedOrigins: ["http://example.com"],
    };
    writeFileSync(path, JSON.stringify(data));
    const result = loadConfig(path);
    expect(result).toEqual(data);
  });

  it("applies defaults for missing optional fields", () => {
    const path = join(tmpDir, "minimal.json");
    writeFileSync(path, JSON.stringify({ roots: ["/Users/foo"] }));
    const result = loadConfig(path);
    expect(result).toEqual({
      port: DEFAULT_PORT,
      roots: ["/Users/foo"],
      allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
    });
  });
});
