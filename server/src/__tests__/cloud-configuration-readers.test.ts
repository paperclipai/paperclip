import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLegacyAdapterSettings } from "../services/adapter-settings.js";
import { inspectLegacyExternalRegistrations } from "../services/cloud-configuration-evidence.js";
import { cloudBundledPackageDigest } from "../services/cloud-bundled-package-digest.js";

vi.mock("../adapters/plugin-loader.js", () => ({ buildExternalAdapters: async () => [] }));

describe("bounded Cloud legacy readers and image inventory", () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "cloud-config-reader-")); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("distinguishes an absent adapter file from a saved empty preference", async () => {
    expect(await readLegacyAdapterSettings({ PAPERCLIP_HOME: root })).toBeNull();
    await fs.writeFile(path.join(root, "adapter-settings.json"), '{"disabledTypes":[]}');
    expect(await readLegacyAdapterSettings({ PAPERCLIP_HOME: root })).toEqual({ disabledTypes: [] });
  });

  it.skipIf(process.platform === "win32")("rejects symlinks and FIFOs without waiting for a writer", async () => {
    const target = path.join(root, "target.json");
    const settings = path.join(root, "adapter-settings.json");
    await fs.writeFile(target, '{"disabledTypes":[]}');
    await fs.symlink(target, settings);
    await expect(readLegacyAdapterSettings({ PAPERCLIP_HOME: root })).rejects.toMatchObject({ code: "ELOOP" });
    expect((await inspectLegacyExternalRegistrations(settings)).blocker).toBe("unreadable_external_registration_metadata");
    await fs.unlink(settings);
    execFileSync("mkfifo", [settings]);
    await expect(readLegacyAdapterSettings({ PAPERCLIP_HOME: root })).rejects.toThrow("regular file");
    expect((await inspectLegacyExternalRegistrations(settings)).blocker).toBe("invalid_external_registration_metadata");
  });

  it.skipIf(process.platform === "win32")("hashes pnpm-style contained links and the physical dependency bytes", async () => {
    const dependency = path.join(root, "node_modules", ".pnpm", "dep@1.0.0", "node_modules", "dep");
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(path.join(dependency, "index.js"), "export const value = 1;");
    await fs.symlink(path.relative(path.join(root, "node_modules"), dependency), path.join(root, "node_modules", "dep"));
    const first = cloudBundledPackageDigest(root);
    await fs.writeFile(path.join(dependency, "index.js"), "export const value = 2;");
    expect(cloudBundledPackageDigest(root)).not.toBe(first);
    await fs.unlink(path.join(root, "node_modules", "dep"));
    await fs.symlink("/", path.join(root, "node_modules", "dep"));
    expect(() => cloudBundledPackageDigest(root)).toThrow("escapes its package");
  });
});
