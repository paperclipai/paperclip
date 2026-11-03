import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectIdleSpool, inspectIdleQuotaRecovery, idleQuotaRecoveryPath, readIdleLocalWork, markIdleIngressTracked, markIdleStartupComplete, registerIdleSpoolDirectory, registerIdleLocalWorkProbe } from "../services/idle-local-work.js";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "idle-spool-")); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });
describe("idle cleanup inspection", () => {
  it("refuses to authorize sleep until startup and ingress tracking are ready", async () => {
    expect(await readIdleLocalWork()).toBe("unknown");
  });
  it("accepts absent and empty directories", async () => {
    expect(await inspectIdleSpool(path.join(root, "absent"))).toBe("none");
    expect(await inspectIdleSpool(root)).toBe("none");
  });
  it.each(["receipt.json", "malformed.json", "partial.tmp", "write.probe", "unexpected"])("retains every spool entry: %s", async name => {
    await fs.writeFile(path.join(root, name), "not valid JSON");
    expect(await inspectIdleSpool(root)).toBe("present");
    await fs.rm(path.join(root, name));
    expect(await inspectIdleSpool(root)).toBe("none");
  });
  it("fails closed on a non-directory, dangling symlink, or read failure", async () => {
    const file = path.join(root, "file"), link = path.join(root, "link");
    await fs.writeFile(file, "");
    await fs.symlink(path.join(root, "missing"), link);
    expect(await inspectIdleSpool(file)).toBe("unknown");
    expect(await inspectIdleSpool(path.join(file, "nested"))).toBe("unknown");
    expect(await inspectIdleSpool(link)).toBe("unknown");
    vi.spyOn(fs, "opendir").mockRejectedValue(Object.assign(new Error("private path"), { code: "EACCES" }));
    expect(await inspectIdleSpool(root)).toBe("unknown");
  });
  it("retains failed local recovery and fails closed on probe errors", async () => {
    vi.stubEnv("PAPERCLIP_HOME", root);
    markIdleIngressTracked(); markIdleStartupComplete({ scheduledBackups: false });
    let pending = true;
    const unregister = registerIdleLocalWorkProbe(() => pending ? "present" : "none");
    try {
      expect(await readIdleLocalWork()).toBe("present");
      pending = false;
      expect(await readIdleLocalWork()).toBe("none");
    } finally { unregister(); }
    const removeBroken = registerIdleLocalWorkProbe(() => { throw new Error("unknown deadline"); });
    try { expect(await readIdleLocalWork()).toBe("unknown"); }
    finally { removeBroken(); }
    expect(await readIdleLocalWork()).toBe("none");
  });

  it("checks custom spool directories as well as the default paths", async () => {
    vi.stubEnv("PAPERCLIP_HOME", root);
    vi.stubEnv("SANDBOX_ORPHAN_CLEANUP_SPOOL_DIR", path.join(root, "orphans"));
    const custom = path.join(root, "custom-accounting");
    registerIdleSpoolDirectory(custom);
    markIdleIngressTracked(); markIdleStartupComplete({ scheduledBackups: false });
    expect(await readIdleLocalWork()).toBe("none");
    markIdleStartupComplete({ scheduledBackups: true });
    expect(await readIdleLocalWork()).toBe("present");
    expect(await readIdleLocalWork({ backupCheckpoint: true })).toBe("none");
    markIdleStartupComplete({ scheduledBackups: false });
    await fs.mkdir(custom);
    await fs.writeFile(path.join(custom, "receipt.tmp"), "incomplete");
    expect(await readIdleLocalWork()).toBe("present");
    expect(await readIdleLocalWork({ backupCheckpoint: true })).toBe("present");
    await fs.rm(custom, { recursive: true });
    expect(await readIdleLocalWork()).toBe("none");
  });

});

describe("idle credential recovery inspection", () => {
  const company = "7238bc31-f3ca-42ba-b487-4122e77b8867";
  it("allows missing roots and empty company directories after successful recovery", async () => {
    expect(await inspectIdleQuotaRecovery(path.join(root, "missing"))).toBe("none");
    expect(await inspectIdleQuotaRecovery(root)).toBe("none");
    await fs.mkdir(path.join(root, company));
    expect(await inspectIdleQuotaRecovery(root)).toBe("none");
  });
  it.each(["receipt.json", "malformed.json", "partial.tmp", "write.probe", "unexpected"])(
    "retains every pending company entry without reading its contents: %s", async name => {
      await fs.mkdir(path.join(root, company));
      const file = path.join(root, company, name);
      await fs.writeFile(file, "unreadable recovery fixture");
      const read = vi.spyOn(fs, "readFile");
      expect(await inspectIdleQuotaRecovery(root)).toBe("present");
      expect(read).not.toHaveBeenCalled();
      await fs.rm(file);
      expect(await inspectIdleQuotaRecovery(root)).toBe("none");
    },
  );
  it("retains unexpected root entries, nested directories and directory symlinks", async () => {
    await fs.mkdir(path.join(root, "unexpected"));
    expect(await inspectIdleQuotaRecovery(root)).toBe("present");
    await fs.rm(path.join(root, "unexpected"), { recursive: true });
    await fs.symlink(path.join(root, "missing"), path.join(root, company));
    expect(await inspectIdleQuotaRecovery(root)).toBe("present");
    await fs.rm(path.join(root, company));
    await fs.mkdir(path.join(root, company, "nested"), { recursive: true });
    expect(await inspectIdleQuotaRecovery(root)).toBe("present");
  });
  it("fails closed on invalid roots and directory read errors", async () => {
    const file = path.join(root, "file"), link = path.join(root, "link");
    await fs.writeFile(file, ""); await fs.symlink(root, link);
    expect(await inspectIdleQuotaRecovery(file)).toBe("unknown");
    expect(await inspectIdleQuotaRecovery(link)).toBe("unknown");
    vi.spyOn(fs, "opendir").mockRejectedValue(Object.assign(new Error("private path"), { code: "EACCES" }));
    expect(await inspectIdleQuotaRecovery(root)).toBe("unknown");
  });
  it("keeps persisted credential recovery awake after the request and process work have ended", async () => {
    vi.stubEnv("PAPERCLIP_HOME", root);
    markIdleIngressTracked(); markIdleStartupComplete({ scheduledBackups: false });
    const directory = path.join(idleQuotaRecoveryPath(), company);
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "pending.json");
    await fs.writeFile(file, "encrypted journal fixture");
    expect(await readIdleLocalWork()).toBe("present");
    await fs.rm(file);
    expect(await readIdleLocalWork()).toBe("none");
  });
});
