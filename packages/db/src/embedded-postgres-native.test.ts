import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureLinuxSharedLibraryAliases, upsertAutoConfSetting } from "./embedded-postgres-native.js";

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

  it("adds dynamic_library_path to postgresql.auto.conf", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-auto-conf-"));
    tempDirs.push(tempDir);
    const autoConfPath = path.join(tempDir, "postgresql.auto.conf");

    await upsertAutoConfSetting(autoConfPath, "dynamic_library_path", "/tmp/native/lib");

    expect(fs.readFileSync(autoConfPath, "utf8")).toBe("dynamic_library_path = '/tmp/native/lib'\n");
  });

  it("replaces an existing dynamic_library_path entry without touching other settings", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-embedded-pg-auto-conf-"));
    tempDirs.push(tempDir);
    const autoConfPath = path.join(tempDir, "postgresql.auto.conf");
    fs.writeFileSync(
      autoConfPath,
      "shared_buffers = '128MB'\ndynamic_library_path = '/old/lib'\nwork_mem = '4MB'\n",
    );

    await upsertAutoConfSetting(autoConfPath, "dynamic_library_path", "/new/lib");

    expect(fs.readFileSync(autoConfPath, "utf8")).toBe(
      "shared_buffers = '128MB'\nwork_mem = '4MB'\ndynamic_library_path = '/new/lib'\n",
    );
  });
});
