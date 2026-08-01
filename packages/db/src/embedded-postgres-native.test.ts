import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLinuxSharedLibraryAliasDirectory } from "./embedded-postgres-native.js";

describe("embedded Postgres native runtime", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("creates soname aliases outside the immutable bundled library directory", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-libs-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, "libicuuc.so.60.2"), "");
    fs.writeFileSync(path.join(tempDir, "libicui18n.so.60.2"), "");
    fs.writeFileSync(path.join(tempDir, "libcrypto.so.1.1"), "");
    fs.writeFileSync(path.join(tempDir, "README.md"), "");
    const before = fs.readdirSync(tempDir).sort();

    const result = await createLinuxSharedLibraryAliasDirectory(tempDir);
    expect(result.aliasDir).not.toBeNull();
    tempDirs.push(result.aliasDir!);

    expect(result.aliases.map((file) => path.basename(file)).sort()).toEqual([
      "libcrypto.so.1",
      "libicui18n.so.60",
      "libicuuc.so.60",
    ]);
    expect(fs.readdirSync(tempDir).sort()).toEqual(before);
    expect(fs.readlinkSync(path.join(result.aliasDir!, "libcrypto.so.1"))).toBe(
      path.join(tempDir, "libcrypto.so.1.1"),
    );
  });

  it.runIf(process.platform !== "win32")("does not create a runtime directory when no aliases are needed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-libs-"));
    tempDirs.push(tempDir);
    fs.writeFileSync(path.join(tempDir, "README.md"), "");

    const result = await createLinuxSharedLibraryAliasDirectory(tempDir);

    expect(result).toEqual({ aliasDir: null, aliases: [] });
  });
});
