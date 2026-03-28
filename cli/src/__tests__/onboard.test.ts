import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onboard } from "../commands/onboard.js";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.chdir(ORIGINAL_CWD);
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("onboard", () => {
  it("fails quickstart when Vercel Blob has no token", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-onboard-"));
    const configPath = path.join(tempRoot, ".paperclip", "config.json");

    try {
      process.chdir(tempRoot);
      process.env.PAPERCLIP_STORAGE_PROVIDER = "vercel_blob";
      delete process.env.PAPERCLIP_STORAGE_VERCEL_BLOB_TOKEN;

      await expect(onboard({ config: configPath, yes: true })).rejects.toThrow(
        "Vercel Blob storage requires storage.vercelBlob.token or PAPERCLIP_STORAGE_VERCEL_BLOB_TOKEN",
      );
      expect(fs.existsSync(configPath)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
