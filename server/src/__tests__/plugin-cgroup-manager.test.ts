import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { platform } from "node:os";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createPluginCgroupManager,
  type PluginCgroupManager,
} from "../services/plugin-cgroup-manager.js";

const MOCK_CGROUP_ROOT = "/mock/sys/fs/cgroup";
const PLUGIN_ID = "acme.test-plugin";
const PLUGIN_PATH = path.join(MOCK_CGROUP_ROOT, "paperclip-plugins", "plugin", PLUGIN_ID);

function mockFsModule(overrides: Record<string, unknown> = {}) {
  vi.doMock("node:fs/promises", () => ({
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation((p: string) => {
      if (String(p).endsWith("cgroup.controllers")) return Promise.resolve("cpu memory pids");
      if (String(p).endsWith("cgroup.events")) return Promise.resolve("populated 0\n");
      if (String(p).endsWith("memory.events")) return Promise.resolve("oom_kill 0\n");
      if (String(p).endsWith("/proc/self/cgroup")) return Promise.resolve(`0::/user.slice/user-1000.slice/user@1000.service/app.slice/test.service\n`);
      return Promise.reject(new Error(`readFile not mocked for: ${p}`));
    }),
    rmdir: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ uid: process.getuid?.() ?? 1000 }),
    access: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }));
}

describe("PluginCgroupManager — unit tests (mocked fs)", () => {
  let manager: PluginCgroupManager;

  beforeEach(async () => {
    vi.resetModules();
    mockFsModule();
    const mod = await import("../services/plugin-cgroup-manager.js");
    manager = mod.createPluginCgroupManager({ cgroupRoot: MOCK_CGROUP_ROOT });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isSupported()", () => {
    it("returns true on Linux with readable cgroup.controllers", async () => {
      if (platform() !== "linux") {
        expect(await manager.isSupported()).toBe(false);
        return;
      }
      expect(await manager.isSupported()).toBe(true);
    });

    it("returns false when cgroup.controllers read fails", async () => {
      vi.resetModules();
      mockFsModule({
        readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      });
      const mod = await import("../services/plugin-cgroup-manager.js");
      const m = mod.createPluginCgroupManager({ cgroupRoot: MOCK_CGROUP_ROOT });
      expect(await m.isSupported()).toBe(false);
    });
  });

  describe("setup(pluginId, limits)", () => {
    it("creates cgroup directory", async () => {
      const { mkdir } = await import("node:fs/promises");
      await manager.setup(PLUGIN_ID, {});
      expect(mkdir).toHaveBeenCalledWith(PLUGIN_PATH, { recursive: true });
    });

    it("writes pids.max when pidsMax is set", async () => {
      const { writeFile } = await import("node:fs/promises");
      await manager.setup(PLUGIN_ID, { pidsMax: 64 });
      expect(writeFile).toHaveBeenCalledWith(
        path.join(PLUGIN_PATH, "pids.max"),
        "64",
        "utf8",
      );
    });

    it("writes memory.high when memoryHighBytes is set", async () => {
      const { writeFile } = await import("node:fs/promises");
      await manager.setup(PLUGIN_ID, { memoryHighBytes: 67108864 });
      expect(writeFile).toHaveBeenCalledWith(
        path.join(PLUGIN_PATH, "memory.high"),
        "67108864",
        "utf8",
      );
    });

    it("writes memory.max when memoryMaxBytes is set", async () => {
      const { writeFile } = await import("node:fs/promises");
      await manager.setup(PLUGIN_ID, { memoryMaxBytes: 134217728 });
      expect(writeFile).toHaveBeenCalledWith(
        path.join(PLUGIN_PATH, "memory.max"),
        "134217728",
        "utf8",
      );
    });

    it("writes cpu.weight when cpuWeight is set", async () => {
      const { writeFile } = await import("node:fs/promises");
      await manager.setup(PLUGIN_ID, { cpuWeight: 200 });
      expect(writeFile).toHaveBeenCalledWith(
        path.join(PLUGIN_PATH, "cpu.weight"),
        "200",
        "utf8",
      );
    });

    it("does not write limit files when limits are empty", async () => {
      const { writeFile } = await import("node:fs/promises");
      await manager.setup(PLUGIN_ID, {});
      // writeFile is called for cgroup.kill and subtree_control on intermediate dirs, but not for any limit file
      const limitFiles = ["pids.max", "memory.high", "memory.max", "cpu.weight"];
      const calls = vi.mocked(writeFile).mock.calls;
      for (const [filePath] of calls) {
        expect(limitFiles.some((f) => String(filePath).endsWith(f))).toBe(false);
      }
    });

    it("writes cgroup.kill to leaf before limit files to evict stale tasks from prior crash", async () => {
      const { writeFile } = await import("node:fs/promises");
      await manager.setup(PLUGIN_ID, { pidsMax: 64 });
      const calls = vi.mocked(writeFile).mock.calls;
      const killIdx = calls.findIndex(([p]) => String(p).endsWith("cgroup.kill"));
      const pidsIdx = calls.findIndex(([p]) => String(p).endsWith("pids.max"));
      expect(killIdx).toBeGreaterThanOrEqual(0);
      expect(pidsIdx).toBeGreaterThan(killIdx);
    });

    it("rejects path traversal in pluginId", async () => {
      await expect(manager.setup("../evil", {})).rejects.toThrow(/invalid plugin id/i);
    });

    it("rejects empty pluginId", async () => {
      await expect(manager.setup("", {})).rejects.toThrow(/invalid plugin id/i);
    });

    it("rmdirs the leaf cgroup if a limit write fails partway through", async () => {
      const { writeFile, rmdir } = await import("node:fs/promises");
      // cgroup.kill and subtree_control writes succeed; the first limit file write fails
      let limitWriteAttempted = false;
      vi.mocked(writeFile).mockImplementation((...args: Parameters<typeof writeFile>) => {
        const filePath = String(args[0]);
        if (filePath.endsWith("cgroup.kill") || filePath.endsWith("cgroup.subtree_control")) {
          return Promise.resolve(undefined as void);
        }
        if (!limitWriteAttempted) {
          limitWriteAttempted = true;
          return Promise.reject(new Error("write failed")) as unknown as Promise<void>;
        }
        return Promise.resolve(undefined as void);
      });
      await expect(manager.setup(PLUGIN_ID, { pidsMax: 64 })).rejects.toThrow("write failed");
      expect(rmdir).toHaveBeenCalledWith(PLUGIN_PATH);
    });
  });

  describe("enterCgroup(pluginId, pid)", () => {
    it("writes pid to cgroup.procs", async () => {
      const { writeFile } = await import("node:fs/promises");
      await manager.enterCgroup(PLUGIN_ID, 12345);
      expect(writeFile).toHaveBeenCalledWith(
        path.join(PLUGIN_PATH, "cgroup.procs"),
        "12345",
        "utf8",
      );
    });

    it("rejects path traversal in pluginId", async () => {
      await expect(manager.enterCgroup("../evil", 1)).rejects.toThrow(/invalid plugin id/i);
    });
  });

  describe("teardown(pluginId)", () => {
    it("writes 1 to cgroup.kill then rmdirs the leaf directory", async () => {
      const { writeFile, rmdir } = await import("node:fs/promises");
      await manager.teardown(PLUGIN_ID);
      expect(writeFile).toHaveBeenCalledWith(
        path.join(PLUGIN_PATH, "cgroup.kill"),
        "1",
        "utf8",
      );
      expect(rmdir).toHaveBeenCalledWith(PLUGIN_PATH);
    });

    it("is idempotent — does not throw when directory is already gone", async () => {
      const { rmdir } = await import("node:fs/promises");
      vi.mocked(rmdir).mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      await expect(manager.teardown(PLUGIN_ID)).resolves.toBeUndefined();
    });

    it("rejects path traversal in pluginId", async () => {
      await expect(manager.teardown("../evil")).rejects.toThrow(/invalid plugin id/i);
    });
  });

  describe("checkOomKill(pluginId)", () => {
    it("returns false when oom_kill is 0", async () => {
      expect(await manager.checkOomKill(PLUGIN_ID)).toBe(false);
    });

    it("returns true when oom_kill > 0", async () => {
      vi.resetModules();
      mockFsModule({
        readFile: vi.fn().mockImplementation((p: string) => {
          if (String(p).endsWith("memory.events")) return Promise.resolve("oom_kill 3\n");
          if (String(p).endsWith("cgroup.controllers")) return Promise.resolve("cpu memory pids");
          return Promise.reject(new Error("not mocked"));
        }),
      });
      const mod = await import("../services/plugin-cgroup-manager.js");
      const m = mod.createPluginCgroupManager({ cgroupRoot: MOCK_CGROUP_ROOT });
      expect(await m.checkOomKill(PLUGIN_ID)).toBe(true);
    });

    it("returns false when memory.events is not readable", async () => {
      vi.resetModules();
      mockFsModule({
        readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
      });
      const mod = await import("../services/plugin-cgroup-manager.js");
      const m = mod.createPluginCgroupManager({ cgroupRoot: MOCK_CGROUP_ROOT });
      expect(await m.checkOomKill(PLUGIN_ID)).toBe(false);
    });
  });

  describe("cgroupPath(pluginId)", () => {
    it("returns path under the cgroup root", () => {
      expect(manager.cgroupPath(PLUGIN_ID)).toBe(PLUGIN_PATH);
    });

    it("rejects path traversal", () => {
      expect(() => manager.cgroupPath("../evil")).toThrow(/invalid plugin id/i);
    });
  });

  describe("effectiveLimits()", () => {
    it("merges defaults and overrides — override wins", () => {
      const result = manager.effectiveLimits(
        { pidsMax: 64, cpuWeight: 100 },
        { pidsMax: 128 },
      );
      expect(result.pidsMax).toBe(128);
      expect(result.cpuWeight).toBe(100);
    });

    it("returns defaults when no overrides", () => {
      const result = manager.effectiveLimits({ pidsMax: 64 }, undefined);
      expect(result.pidsMax).toBe(64);
    });

    it("returns empty object when both undefined", () => {
      expect(manager.effectiveLimits(undefined, undefined)).toEqual({});
    });
  });
});
