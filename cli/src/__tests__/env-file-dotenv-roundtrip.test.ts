import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mergePaperclipEnvEntries, readPaperclipEnvEntries } from "../config/env.js";

describe("paperclip env file round trip", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "C:\\Users\\nick\\.paperclip-worktrees\\instances\\repo",
    "C:\\Users\\ann\\repos\\app\\.paperclip\\config.json",
    'name with "quotes"',
  ])("reads back %s as written", (value) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-env-roundtrip-"));
    tempDirs.push(dir);
    const envPath = path.join(dir, ".env");

    mergePaperclipEnvEntries({ PAPERCLIP_HOME: value }, envPath);

    expect(readPaperclipEnvEntries(envPath).PAPERCLIP_HOME).toBe(value);
  });
});
