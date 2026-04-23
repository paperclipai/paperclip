import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  mergePaperclipEnvEntries,
  readAgentJwtSecretFromEnvFile,
  readPaperclipEnvEntries,
  writePaperclipEnvEntries,
} from "./env.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-env-test-"));
  tempDirs.push(dir);
  return dir;
}

function envFilePath(dir: string): string {
  return path.join(dir, ".env");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

// ============================================================================
// readPaperclipEnvEntries
// ============================================================================

describe("readPaperclipEnvEntries", () => {
  it("returns empty object when file does not exist", () => {
    const dir = makeTempDir();
    const result = readPaperclipEnvEntries(envFilePath(dir));
    expect(result).toEqual({});
  });

  it("parses KEY=value entries from the file", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    fs.writeFileSync(file, "MY_KEY=my_value\n");
    const result = readPaperclipEnvEntries(file);
    expect(result["MY_KEY"]).toBe("my_value");
  });

  it("parses quoted values (double quotes)", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    fs.writeFileSync(file, 'QUOTED="hello world"\n');
    const result = readPaperclipEnvEntries(file);
    expect(result["QUOTED"]).toBe("hello world");
  });

  it("parses multiple entries", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    fs.writeFileSync(file, "A=one\nB=two\n");
    const result = readPaperclipEnvEntries(file);
    expect(result["A"]).toBe("one");
    expect(result["B"]).toBe("two");
  });

  it("returns empty object when file is empty", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    fs.writeFileSync(file, "");
    const result = readPaperclipEnvEntries(file);
    expect(result).toEqual({});
  });
});

// ============================================================================
// writePaperclipEnvEntries
// ============================================================================

describe("writePaperclipEnvEntries", () => {
  it("creates the .env file with given entries", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    writePaperclipEnvEntries({ FOO: "bar" }, file);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("written file contains the key=value pair", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    writePaperclipEnvEntries({ HELLO: "world" }, file);
    const contents = fs.readFileSync(file, "utf-8");
    expect(contents).toContain("HELLO=world");
  });

  it("creates parent directory if it does not exist", () => {
    const dir = makeTempDir();
    const nested = path.join(dir, "sub", "dir", ".env");
    writePaperclipEnvEntries({ X: "1" }, nested);
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("overwrites existing file content", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    fs.writeFileSync(file, "OLD=value\n");
    writePaperclipEnvEntries({ NEW: "value" }, file);
    const contents = fs.readFileSync(file, "utf-8");
    expect(contents).toContain("NEW=value");
    expect(contents).not.toContain("OLD=value");
  });

  it("written content round-trips through readPaperclipEnvEntries", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    const original = { KEY_A: "value_a", KEY_B: "value_b" };
    writePaperclipEnvEntries(original, file);
    const restored = readPaperclipEnvEntries(file);
    expect(restored["KEY_A"]).toBe("value_a");
    expect(restored["KEY_B"]).toBe("value_b");
  });

  it("quotes values with special characters using JSON stringify", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    writePaperclipEnvEntries({ SPECIAL: "hello world" }, file);
    const contents = fs.readFileSync(file, "utf-8");
    // Value with space should be JSON-quoted
    expect(contents).toContain('"hello world"');
  });
});

// ============================================================================
// mergePaperclipEnvEntries
// ============================================================================

describe("mergePaperclipEnvEntries", () => {
  it("creates file and writes entries when file does not exist", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    const result = mergePaperclipEnvEntries({ FOO: "bar" }, file);
    expect(result["FOO"]).toBe("bar");
    expect(fs.existsSync(file)).toBe(true);
  });

  it("merges new entries with existing ones", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    writePaperclipEnvEntries({ EXISTING: "old" }, file);
    const result = mergePaperclipEnvEntries({ NEW_KEY: "new_val" }, file);
    expect(result["EXISTING"]).toBe("old");
    expect(result["NEW_KEY"]).toBe("new_val");
  });

  it("overwrites existing key with new value", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    writePaperclipEnvEntries({ KEY: "old" }, file);
    const result = mergePaperclipEnvEntries({ KEY: "new" }, file);
    expect(result["KEY"]).toBe("new");
  });

  it("filters out entries with empty-string values", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    const result = mergePaperclipEnvEntries({ BLANK: "" }, file);
    expect(result["BLANK"]).toBeUndefined();
  });

  it("filters out entries with whitespace-only values", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    const result = mergePaperclipEnvEntries({ SPACES: "   " }, file);
    expect(result["SPACES"]).toBeUndefined();
  });

  it("persists merged entries to disk", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    writePaperclipEnvEntries({ A: "1" }, file);
    mergePaperclipEnvEntries({ B: "2" }, file);
    const onDisk = readPaperclipEnvEntries(file);
    expect(onDisk["A"]).toBe("1");
    expect(onDisk["B"]).toBe("2");
  });

  it("returns the merged entries object", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    writePaperclipEnvEntries({ X: "x_val" }, file);
    const result = mergePaperclipEnvEntries({ Y: "y_val" }, file);
    expect(typeof result).toBe("object");
    expect(result["X"]).toBe("x_val");
    expect(result["Y"]).toBe("y_val");
  });
});

// ============================================================================
// readAgentJwtSecretFromEnvFile
// ============================================================================

describe("readAgentJwtSecretFromEnvFile", () => {
  it("returns null when file does not exist", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    expect(readAgentJwtSecretFromEnvFile(file)).toBeNull();
  });

  it("returns null when PAPERCLIP_AGENT_JWT_SECRET is absent from file", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    writePaperclipEnvEntries({ OTHER_KEY: "value" }, file);
    expect(readAgentJwtSecretFromEnvFile(file)).toBeNull();
  });

  it("returns the secret when present in file", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    writePaperclipEnvEntries({ PAPERCLIP_AGENT_JWT_SECRET: "my-test-secret" }, file);
    expect(readAgentJwtSecretFromEnvFile(file)).toBe("my-test-secret");
  });

  it("returns null when secret value is empty string", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    // Write raw file with empty value
    fs.writeFileSync(file, "PAPERCLIP_AGENT_JWT_SECRET=\n");
    expect(readAgentJwtSecretFromEnvFile(file)).toBeNull();
  });

  it("trims whitespace from the secret value", () => {
    const dir = makeTempDir();
    const file = envFilePath(dir);
    // Manually write a file with surrounding spaces (uncommon but possible)
    fs.writeFileSync(file, 'PAPERCLIP_AGENT_JWT_SECRET="  trimmed  "\n');
    const result = readAgentJwtSecretFromEnvFile(file);
    // After parse by dotenv and trim(), should be "trimmed"
    expect(result).toBe("trimmed");
  });
});
