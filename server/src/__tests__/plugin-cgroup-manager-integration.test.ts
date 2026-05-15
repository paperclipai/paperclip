/**
 * Tier 2 integration tests — real cgroupsv2 filesystem.
 *
 * These tests use the actual /sys/fs/cgroup hierarchy under the delegated
 * user slice. They are skipped when cgroupsv2 is not available (non-Linux
 * hosts, or Linux hosts where the user does not have cgroup delegation).
 *
 * Test cgroup root: app.slice/paperclip-test-ccc2.slice/
 * This is separate from the production paperclip.service cgroup and is
 * cleaned up after each test.
 *
 * HARD RULE: Never touch paperclip.service's cgroup in these tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { platform } from "node:os";
import { mkdir, readFile, rmdir, writeFile, access } from "node:fs/promises";
import * as path from "node:path";
import { createPluginCgroupManager } from "../services/plugin-cgroup-manager.js";

const USER_ID = process.getuid?.() ?? 1000;
const APP_SLICE = `/sys/fs/cgroup/user.slice/user-${USER_ID}.slice/user@${USER_ID}.service/app.slice`;
const TEST_CGROUP_ROOT = path.join(APP_SLICE, "paperclip-test-ccc2.slice");
const PLUGIN_ID = "acme.integration-test";
const PLUGIN_CGROUP_PATH = path.join(TEST_CGROUP_ROOT, "paperclip-plugins", "plugin", PLUGIN_ID);

async function cgroupsv2Available(): Promise<boolean> {
  if (platform() !== "linux") return false;
  try {
    const content = await readFile(path.join(APP_SLICE, "cgroup.controllers"), "utf8");
    return content.trim().length > 0;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") return false;
    throw err;
  }
}

async function ensureTestSlice(): Promise<void> {
  await mkdir(TEST_CGROUP_ROOT, { recursive: true });
  const controllers = await readFile(
    path.join(APP_SLICE, "cgroup.controllers"), "utf8"
  ).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "EACCES") return "";
    throw err;
  });
  const available = controllers.trim().split(/\s+/);
  const toEnable = available.filter((c) => ["cpu", "memory", "pids"].includes(c));
  if (toEnable.length > 0) {
    await writeFile(
      path.join(TEST_CGROUP_ROOT, "cgroup.subtree_control"),
      toEnable.map((c) => `+${c}`).join(" "),
      "utf8",
    ).catch((err: NodeJS.ErrnoException) => {
      // EINVAL: already enabled or not available
      // ENOENT: TEST_CGROUP_ROOT exists as filesystem dir but is not a real cgroup
      //   (kernel didn't create pseudo-files) — not a delegated cgroupsv2 host
      if (err.code !== "EINVAL" && err.code !== "ENOENT") throw err;
    });
  }
}

describe("PluginCgroupManager — integration tests (real cgroupsv2)", () => {
  let supported = false;

  beforeEach(async () => {
    if (!await cgroupsv2Available()) {
      supported = false;
      return;
    }
    await ensureTestSlice();
    // Canary probe: attempt to actually write a limit file to a leaf cgroup.
    // isSupported() only checks cgroup.controllers existence; on some CI runners
    // controllers are listed but not delegated deep enough for leaf writes (EACCES).
    // A real write probe is the only reliable skip gate.
    const canaryDir = path.join(TEST_CGROUP_ROOT, "paperclip-plugins", "plugin", "canary.probe");
    try {
      const mgr = createPluginCgroupManager({ cgroupRoot: TEST_CGROUP_ROOT });
      await mgr.setup("canary.probe", { pidsMax: 32 });
      supported = true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM" || code === "EINVAL" || code === "ENOENT") {
        supported = false;
      } else {
        throw err;
      }
    } finally {
      await rmdir(canaryDir).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT" && e.code !== "EBUSY" && e.code !== "ENOTEMPTY") throw e;
      });
    }
  });

  afterEach(async () => {
    // cgroup dirs must be removed bottom-up with rmdir (rm -rf does not work on cgroupfs)
    const dirsToTry = [
      path.join(TEST_CGROUP_ROOT, "paperclip-plugins", "plugin", PLUGIN_ID),
      path.join(TEST_CGROUP_ROOT, "paperclip-plugins", "plugin"),
      path.join(TEST_CGROUP_ROOT, "paperclip-plugins"),
    ];
    for (const dir of dirsToTry) {
      await rmdir(dir).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT" && err.code !== "EBUSY" && err.code !== "ENOTEMPTY") {
          console.error(`afterEach rmdir failed for ${dir}:`, err.message);
        }
      });
    }
  });

  it("isSupported() returns true on a delegated cgroupsv2 host", async () => {
    if (!supported) {
      console.log("skipping: cgroupsv2 not available");
      return;
    }
    const manager = createPluginCgroupManager({ cgroupRoot: TEST_CGROUP_ROOT });
    expect(await manager.isSupported()).toBe(true);
  });

  it("setup() creates cgroup directory and writes pids.max", async () => {
    if (!supported) {
      console.log("skipping: cgroupsv2 not available");
      return;
    }
    const manager = createPluginCgroupManager({ cgroupRoot: TEST_CGROUP_ROOT });
    await manager.setup(PLUGIN_ID, { pidsMax: 32 });

    const pidsMax = await readFile(path.join(PLUGIN_CGROUP_PATH, "pids.max"), "utf8");
    expect(pidsMax.trim()).toBe("32");
  });

  it("enterCgroup() rejects invalid pluginId before any filesystem call", async () => {
    if (!supported) {
      console.log("skipping: cgroupsv2 not available");
      return;
    }
    const manager = createPluginCgroupManager({ cgroupRoot: TEST_CGROUP_ROOT });
    await expect(manager.enterCgroup("../evil", 1)).rejects.toThrow(/invalid plugin id/i);
  });

  it("teardown() removes the cgroup directory", async () => {
    if (!supported) {
      console.log("skipping: cgroupsv2 not available");
      return;
    }
    const manager = createPluginCgroupManager({ cgroupRoot: TEST_CGROUP_ROOT });
    await manager.setup(PLUGIN_ID, {});
    await manager.teardown(PLUGIN_ID);

    await expect(access(PLUGIN_CGROUP_PATH)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("teardown() is idempotent — does not throw when already removed", async () => {
    if (!supported) {
      console.log("skipping: cgroupsv2 not available");
      return;
    }
    const manager = createPluginCgroupManager({ cgroupRoot: TEST_CGROUP_ROOT });
    await expect(manager.teardown(PLUGIN_ID)).resolves.toBeUndefined();
  });

  it("cgroupPath() returns path inside test root", () => {
    const manager = createPluginCgroupManager({ cgroupRoot: TEST_CGROUP_ROOT });
    expect(manager.cgroupPath(PLUGIN_ID)).toBe(PLUGIN_CGROUP_PATH);
  });
});
