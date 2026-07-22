import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLinuxSharedLibraryAliases, mergeEmbeddedPostgresSpawnEnv } from "./embedded-postgres-native.js";

describe("embedded Postgres native runtime", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("creates soname aliases for bundled patch-level shared libraries", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-libs-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, "libicuuc.so.60.2"), "");
    fs.writeFileSync(path.join(tempDir, "libicui18n.so.60.2"), "");
    fs.writeFileSync(path.join(tempDir, "README.md"), "");

    const created = await ensureLinuxSharedLibraryAliases(tempDir);

    expect(created.map((file) => path.basename(file)).sort()).toEqual([
      "libicui18n.so.60",
      "libicuuc.so.60",
    ]);
    expect(fs.readlinkSync(path.join(tempDir, "libicuuc.so.60"))).toBe("libicuuc.so.60.2");
  });

  it.runIf(process.platform !== "win32")("is idempotent when aliases already exist", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-libs-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, "libicuuc.so.60.2"), "");

    await ensureLinuxSharedLibraryAliases(tempDir);
    const second = await ensureLinuxSharedLibraryAliases(tempDir);

    expect(second).toEqual([]);
    expect(fs.readlinkSync(path.join(tempDir, "libicuuc.so.60"))).toBe("libicuuc.so.60.2");
  });
});

describe("embedded Postgres spawn environment", () => {
  it("preserves the process environment for initdb and forces a portable locale", () => {
    const previousPath = process.env.PATH;
    process.env.PATH = "/paperclip/bin";
    try {
      expect(mergeEmbeddedPostgresSpawnEnv("/native/bin/initdb", { env: { LC_MESSAGES: "en_US.UTF-8" } })).toEqual({
        env: expect.objectContaining({ PATH: "/paperclip/bin", LC_MESSAGES: "C" }),
      });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("does not alter unrelated child processes", () => {
    const options = { env: { ONLY: "value" } };
    expect(mergeEmbeddedPostgresSpawnEnv("node", options)).toBe(options);
  });
});
