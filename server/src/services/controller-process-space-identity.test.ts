import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ read: vi.fn(), link: vi.fn(), sysctl: vi.fn(), selfBirth: vi.fn() }));
vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>(),
  readFileSync: state.read, readlinkSync: state.link }));
vi.mock("node:os", async original => ({ ...await original<typeof import("node:os")>(), hostname: () => "same-host" }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), execFileSync: state.sysctl }));
vi.mock("./hot-restart.js", () => ({ readProcessStartedAt: state.selfBirth }));

const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const firstBoot = "00000000-0000-4000-8000-000000000001";
const secondBoot = "00000000-0000-4000-8000-000000000002";
function platform(value: string) { Object.defineProperty(process, "platform", { ...descriptor, value }); }
async function fresh() { vi.resetModules(); return import("./controller-process-identity.js"); }

beforeEach(() => {
  vi.resetAllMocks();
  state.read.mockReturnValue(firstBoot + "\n"); state.link.mockReturnValue("pid:[42]");
  state.sysctl.mockReturnValue(firstBoot.toUpperCase() + "\n");
  state.selfBirth.mockResolvedValue("2026-11-07T00:00:00.000Z");
});
afterEach(() => { Object.defineProperty(process, "platform", descriptor); vi.restoreAllMocks(); });

describe("controller process-space identity", () => {
  it("keeps Linux boot and PID-namespace isolation without launching a command", async () => {
    platform("linux");
    const original = await (await fresh()).currentControllerProcess();
    expect(original.hostHash).toMatch(/^[0-9a-f]{32}$/);
    expect(state.read).toHaveBeenCalledWith("/proc/sys/kernel/random/boot_id", "utf8");
    expect(state.link).toHaveBeenCalledWith("/proc/self/ns/pid");
    expect(state.sysctl).not.toHaveBeenCalled();
    state.link.mockReturnValue("pid:[43]");
    expect((await (await fresh()).currentControllerProcess()).hostHash).not.toBe(original.hostHash);
    state.link.mockReturnValue("pid:[42]"); state.read.mockReturnValue(secondBoot);
    expect((await (await fresh()).currentControllerProcess()).hostHash).not.toBe(original.hostHash);
  });

  it("uses Darwin kernel boot UUID once per module, never a rounded clock identity", async () => {
    platform("darwin");
    const owner = await fresh();
    const first = await owner.currentControllerProcess();
    expect(first.hostHash).toMatch(/^[0-9a-f]{32}$/);
    expect(state.sysctl).toHaveBeenCalledExactlyOnceWith("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"],
      { encoding: "utf8", timeout: 1_500, maxBuffer: 4_096, windowsHide: true });
    expect(state.read).not.toHaveBeenCalled(); expect(state.link).not.toHaveBeenCalled();
    state.sysctl.mockReturnValue(secondBoot);
    expect((await owner.currentControllerProcess()).hostHash).toBe(first.hostHash);
    expect(state.sysctl).toHaveBeenCalledTimes(1);
    expect((await (await fresh()).currentControllerProcess()).hostHash).not.toBe(first.hostHash);
    expect(state.sysctl).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(first)).not.toContain(firstBoot);
    // Old weak/foreign receipts retain their original deadline: no local probe.
    expect(owner.sameProcessSpace("old-rounded-clock-hash")).toBe(false);
    expect(owner.sameProcessSpace(first.hostHash)).toBe(true);
  });

  it.each(["unreadable", "malformed", "unsupported"] as const)("fails closed without an owner PID probe for %s identity", async mode => {
    platform(mode === "unsupported" ? "win32" : "darwin");
    if (mode === "unreadable") state.sysctl.mockImplementation(() => { throw new Error("sysctl unavailable"); });
    if (mode === "malformed") state.sysctl.mockReturnValue("not-a-kernel-uuid");
    const owner = await fresh();
    expect((await owner.currentControllerProcess()).hostHash).toBe("unknown");
    expect(owner.sameProcessSpace("unknown")).toBe(false);
    if (mode === "unsupported") expect(state.sysctl).not.toHaveBeenCalled();
  });
});
