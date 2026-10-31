import type { Environment } from "@paperclipai/shared";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAdmissionCommand, selectOverflowEnvironmentId, type EnvironmentOverflowDeps } from "./environment-overflow.js";

const env = (id: string, capacity?: Record<string, unknown>, extra: Partial<Environment> = {}) =>
  ({ id, status: "active", driver: id === "local" ? "local" : "ssh", config: capacity ? { capacity } : {}, ...extra }) as Environment;

function deps(environments: Environment[], leases: Record<string, number> = {}, overrides: Partial<EnvironmentOverflowDeps> = {}): EnvironmentOverflowDeps {
  return {
    getEnvironment: async (id) => environments.find((e) => e.id === id) ?? null,
    findAffinityEnvironmentId: async () => null,
    countActiveLeases: async (id) => leases[id] ?? 0,
    admit: async () => true,
    ...overrides,
  };
}

const select = (d: EnvironmentOverflowDeps, fallbacks = ["nomad"]) =>
  selectOverflowEnvironmentId({ primaryEnvironmentId: "local", fallbackEnvironmentIds: fallbacks }, d);

describe("environment overflow selection", () => {
  it("keeps the primary while it has capacity", async () => {
    expect(await select(deps([env("local", { maxConcurrentRuns: 1 }), env("nomad")]))).toBe("local");
  });

  it("overflows to the next admitted candidate when the primary is full", async () => {
    expect(await select(deps([env("local", { maxConcurrentRuns: 1 }), env("nomad")], { local: 1 }))).toBe("nomad");
  });

  it("admits no candidate when the primary is full and every fallback refuses", async () => {
    const admit = vi.fn(async () => false);
    const d = deps([env("local", { maxConcurrentRuns: 1 }), env("nomad", { admissionCommand: ["probe"] })], { local: 1 }, { admit });
    expect(await select(d)).toBeNull();
    expect(admit).toHaveBeenCalledWith(["probe"]);
  });

  it("skips archived, non-host and missing candidates", async () => {
    const d = deps([env("local", { maxConcurrentRuns: 1 }), env("other", undefined, { driver: "sandbox" }), env("off", undefined, { status: "archived" as Environment["status"] }), env("nomad")], { local: 1 });
    expect(await select(d, ["missing", "other", "off", "nomad"])).toBe("nomad");
  });

  it("prefers the candidate that hosted the session while it still admits", async () => {
    const pinned = deps([env("local", { maxConcurrentRuns: 1 }), env("nomad")], {}, { findAffinityEnvironmentId: async () => "nomad" });
    expect(await select(pinned)).toBe("nomad");
    const departed = deps([env("local", { maxConcurrentRuns: 1 }), env("nomad", { admissionCommand: ["probe"] })], {},
      { findAffinityEnvironmentId: async () => "nomad", admit: async () => false });
    expect(await select(departed)).toBe("local");
  });

  it("does not query anything without fallbacks", async () => {
    const getEnvironment = vi.fn();
    expect(await select(deps([], {}, { getEnvironment }), [])).toBe("local");
    expect(getEnvironment).not.toHaveBeenCalled();
  });

  it("admits only a zero exit within the timeout", async () => {
    expect(await runAdmissionCommand(["sh", "-c", "exit 0"])).toBe(true);
    expect(await runAdmissionCommand(["sh", "-c", "exit 3"])).toBe(false);
    expect(await runAdmissionCommand(["/nonexistent/paperclip-probe"])).toBe(false);
    expect(await runAdmissionCommand(["sh", "-c", "sleep 5"], 100)).toBe(false);
  });

  it("kills the probe's whole process group on timeout", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "admission-probe-")), "pid");
    expect(await runAdmissionCommand(["sh", "-c", `sleep 60 & echo $! > ${pidFile}; wait`], 300)).toBe(false);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    const alive = () => { try { process.kill(grandchild, 0); return true; } catch { return false; } };
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5_000 });
  });
});
