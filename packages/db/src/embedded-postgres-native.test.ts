import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLinuxSharedLibraryAliases, prepareEmbeddedPostgresNativeRuntime } from "./embedded-postgres-native.js";

const require = createRequire(import.meta.url);

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

  it("keeps the child process API untouched while preparing the runtime", async () => {
    const originalSpawn = childProcess.spawn;

    await prepareEmbeddedPostgresNativeRuntime();

    expect(childProcess.spawn).toBe(originalSpawn);
  });

  it("uses the dependency-scoped portable locale patch", () => {
    const source = fs.readFileSync(require.resolve("embedded-postgres"), "utf8");

    expect(source).toContain("const LC_MESSAGES_LOCALE = 'C';");
    expect(source).toContain("globalThis.process.env");
  });
});
