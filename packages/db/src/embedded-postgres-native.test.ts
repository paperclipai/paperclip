import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import EmbeddedPostgres from "embedded-postgres";
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

  it.runIf(process.platform === "win32")("gracefully stops and restarts an owned native Windows cluster without retaining its port", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-owned-pg-shutdown-"));
    const listener = createServer();
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    const instance = new EmbeddedPostgres({ databaseDir: path.join(root, "db"), port, user: "fixture", password: "fixture",
      persistent: true, createPostgresUser: false, initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-messages=C"],
      onLog: () => {}, onError: () => {} });
    try {
      await instance.initialise();
      for (let generation = 0; generation < 2; generation++) {
        await instance.start();
        const client = instance.getPgClient();
        try { await client.connect(); expect((await client.query("select 1 as value")).rows[0].value).toBe(1); }
        finally { await client.end(); }
        if (generation === 0) {
          const pidPath = path.join(root, "db", "postmaster.pid");
          const savedPid = fs.readFileSync(pidPath, "utf8");
          try {
            fs.writeFileSync(pidPath, savedPid.replace(/^\d+/, "1"));
            await expect(instance.stop()).rejects.toThrow("shutdown ownership changed");
          } finally { fs.writeFileSync(pidPath, savedPid); }
        }
        await instance.stop();
        const released = createServer();
        await new Promise<void>((resolve, reject) => { released.once("error", reject); released.listen(port, "127.0.0.1", resolve); });
        await new Promise<void>((resolve, reject) => released.close(error => error ? reject(error) : resolve()));
      }
    } finally {
      await instance.stop();
      tempDirs.push(root);
    }
  }, 60_000);
});
