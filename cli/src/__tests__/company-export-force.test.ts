import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { confirmOverwriteExportDirectory } from "../commands/client/company.js";

// These tests run under vitest, where stdin/stdout are not TTYs — i.e. exactly
// the non-interactive/automated posture the nightly backup routine runs in.
describe("confirmOverwriteExportDirectory (non-interactive)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pc-export-force-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves when the output directory does not exist", async () => {
    const missing = path.join(dir, "does-not-exist");
    await expect(confirmOverwriteExportDirectory(missing)).resolves.toBeUndefined();
  });

  it("resolves when the output directory is empty", async () => {
    await expect(confirmOverwriteExportDirectory(dir)).resolves.toBeUndefined();
  });

  it("throws non-interactively when the output directory is non-empty and --force is not set", async () => {
    await writeFile(path.join(dir, "BACKUP-README.md"), "keep me");
    await mkdir(path.join(dir, ".git"));
    await expect(confirmOverwriteExportDirectory(dir)).rejects.toThrow(/already contains files/);
  });

  it("resolves on a non-empty output directory when --force is set", async () => {
    await writeFile(path.join(dir, "BACKUP-README.md"), "keep me");
    await mkdir(path.join(dir, ".git"));
    await expect(
      confirmOverwriteExportDirectory(dir, { force: true }),
    ).resolves.toBeUndefined();
  });

  it("throws when the output path exists but is a file", async () => {
    const filePath = path.join(dir, "not-a-dir");
    await writeFile(filePath, "x");
    await expect(confirmOverwriteExportDirectory(filePath, { force: true })).rejects.toThrow(
      /exists and is not a directory/,
    );
  });
});
