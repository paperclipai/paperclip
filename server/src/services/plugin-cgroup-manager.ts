import { mkdir, writeFile, rmdir, readFile } from "node:fs/promises";
import { platform } from "node:os";
import * as path from "node:path";
import type { PluginCgroupLimits } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "plugin-cgroup-manager" });

const PLUGIN_ID_REGEX = /^[a-z][a-z0-9._-]+$/;

export interface PluginCgroupManager {
  isSupported(): Promise<boolean>;
  setup(pluginId: string, limits: PluginCgroupLimits): Promise<void>;
  enterCgroup(pluginId: string, pid: number): Promise<void>;
  teardown(pluginId: string): Promise<void>;
  checkOomKill(pluginId: string): Promise<boolean>;
  cgroupPath(pluginId: string): string;
  effectiveLimits(
    defaults: PluginCgroupLimits | undefined,
    overrides: PluginCgroupLimits | undefined,
  ): PluginCgroupLimits;
}

export interface PluginCgroupManagerOptions {
  cgroupRoot: string;
}

function validatePluginId(pluginId: string): void {
  if (!pluginId || !PLUGIN_ID_REGEX.test(pluginId)) {
    throw new Error(`Invalid plugin id for cgroup path: "${pluginId}"`);
  }
}

function buildPluginCgroupPath(cgroupRoot: string, pluginId: string): string {
  validatePluginId(pluginId);
  const candidate = path.join(cgroupRoot, "paperclip-plugins", "plugin", pluginId);
  const prefix = path.join(cgroupRoot, "paperclip-plugins", "plugin") + path.sep;
  if (!candidate.startsWith(prefix)) {
    throw new Error(`Invalid plugin id for cgroup path: "${pluginId}"`);
  }
  return candidate;
}

export function createPluginCgroupManager(
  options: PluginCgroupManagerOptions,
): PluginCgroupManager {
  const { cgroupRoot } = options;

  // Cache the support check — cgroupsv2 availability can't change without a restart.
  let supportedCache: boolean | undefined;

  async function isSupported(): Promise<boolean> {
    if (supportedCache !== undefined) return supportedCache;
    if (platform() !== "linux") {
      supportedCache = false;
      return false;
    }
    try {
      const content = await readFile(path.join(cgroupRoot, "cgroup.controllers"), "utf8");
      // Require at least one of the controllers we actually use.
      const controllers = content.trim().split(/\s+/);
      const hasUsable = controllers.some((c) => ["memory", "pids", "cpu"].includes(c));
      supportedCache = hasUsable;
      return hasUsable;
    } catch {
      supportedCache = false;
      return false;
    }
  }

  async function setup(pluginId: string, limits: PluginCgroupLimits): Promise<void> {
    const cgroupDir = buildPluginCgroupPath(cgroupRoot, pluginId);
    // Create the full path including intermediate dirs
    await mkdir(cgroupDir, { recursive: true });
    // Kill any processes left over from a previous crashed instance. The cgroup
    // dir may already exist (mkdir is idempotent) but still have stale tasks in
    // cgroup.procs from a prior worker that crashed before teardown ran. Writing
    // cgroup.kill evicts them so the new worker enters a clean leaf.
    await writeFile(path.join(cgroupDir, "cgroup.kill"), "1", "utf8").catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT" && err.code !== "EINVAL") throw err;
      },
    );
    // Enable controllers at each intermediate level so the leaf can use them.
    // These writes are idempotent — re-enabling an already-enabled controller is a no-op.
    const intermediates = [
      path.join(cgroupRoot, "paperclip-plugins"),
      path.join(cgroupRoot, "paperclip-plugins", "plugin"),
    ];
    for (const dir of intermediates) {
      await writeFile(
        path.join(dir, "cgroup.subtree_control"),
        "+pids +memory +cpu",
        "utf8",
      ).catch((err: NodeJS.ErrnoException) => {
        // ENOENT: controller file absent (non-Linux or unsupported controller) — ignore
        // EINVAL: already enabled or not available — ignore
        if (err.code !== "ENOENT" && err.code !== "EINVAL") throw err;
      });
    }
    try {
      await writeLimits(cgroupDir, limits);
    } catch (err) {
      await rmdir(cgroupDir).catch((rmErr: unknown) => {
        log.error({ rmErr: rmErr instanceof Error ? rmErr.message : String(rmErr), pluginId },
          "cgroup cleanup after limit write failure also failed");
      });
      throw err;
    }
  }

  function validateLimits(limits: PluginCgroupLimits): void {
    if (
      limits.memoryHighBytes !== undefined &&
      limits.memoryMaxBytes !== undefined &&
      limits.memoryMaxBytes < limits.memoryHighBytes
    ) {
      throw new Error(
        `Invalid cgroup limits: memoryMaxBytes (${limits.memoryMaxBytes}) must be >= memoryHighBytes (${limits.memoryHighBytes})`,
      );
    }
  }

  async function writeLimits(cgroupDir: string, limits: PluginCgroupLimits): Promise<void> {
    validateLimits(limits);
    if (limits.pidsMax !== undefined) {
      await writeFile(path.join(cgroupDir, "pids.max"), String(limits.pidsMax), "utf8");
    }
    if (limits.memoryHighBytes !== undefined) {
      await writeFile(path.join(cgroupDir, "memory.high"), String(limits.memoryHighBytes), "utf8");
    }
    if (limits.memoryMaxBytes !== undefined) {
      await writeFile(path.join(cgroupDir, "memory.max"), String(limits.memoryMaxBytes), "utf8");
    }
    if (limits.cpuWeight !== undefined) {
      await writeFile(path.join(cgroupDir, "cpu.weight"), String(limits.cpuWeight), "utf8");
    }
  }

  async function enterCgroup(pluginId: string, pid: number): Promise<void> {
    const cgroupDir = buildPluginCgroupPath(cgroupRoot, pluginId);
    await writeFile(path.join(cgroupDir, "cgroup.procs"), String(pid), "utf8");
  }

  async function teardown(pluginId: string): Promise<void> {
    const cgroupDir = buildPluginCgroupPath(cgroupRoot, pluginId);
    try {
      await writeFile(path.join(cgroupDir, "cgroup.kill"), "1", "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.warn({ pluginId, err: err instanceof Error ? err.message : String(err) },
          "cgroup.kill write failed — continuing teardown");
      }
    }
    try {
      // cgroup directories must be removed with rmdir, not rm -rf.
      // The kernel removes them only when empty (no processes, no child cgroups).
      await rmdir(cgroupDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      log.warn({ pluginId, err: err instanceof Error ? err.message : String(err) },
        "cgroup rmdir failed");
    }
  }

  async function checkOomKill(pluginId: string): Promise<boolean> {
    const cgroupDir = buildPluginCgroupPath(cgroupRoot, pluginId);
    try {
      const content = await readFile(path.join(cgroupDir, "memory.events"), "utf8");
      const match = content.match(/^oom_kill\s+(\d+)/m);
      if (match && parseInt(match[1], 10) > 0) return true;
    } catch {
      // non-fatal
    }
    return false;
  }

  function cgroupPath(pluginId: string): string {
    return buildPluginCgroupPath(cgroupRoot, pluginId);
  }

  function effectiveLimits(
    defaults: PluginCgroupLimits | undefined,
    overrides: PluginCgroupLimits | undefined,
  ): PluginCgroupLimits {
    const merged = { ...(defaults ?? {}), ...(overrides ?? {}) };
    validateLimits(merged);
    return merged;
  }

  return { isSupported, setup, enterCgroup, teardown, checkOomKill, cgroupPath, effectiveLimits };
}
