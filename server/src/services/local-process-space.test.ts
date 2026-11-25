import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { observeLinuxKernelBoot, readLocalKernelBoot, localKernelRestarted } from "./local-process-space.js";

const observations = vi.hoisted(() => ({ read: vi.fn(), link: vi.fn(), command: vi.fn() }));
vi.mock("node:fs", () => ({ readFileSync: observations.read, readlinkSync: observations.link }));
vi.mock("node:child_process", () => ({ execFileSync: observations.command }));
const boot = "11111111-1111-4111-8111-111111111111";
const nextBoot = "22222222-2222-4222-8222-222222222222";
const physicalHost = "33333333-3333-4333-8333-333333333333";
const namespace = "pid:[4026532471]";
const space = (kernel = boot, ns = namespace) => createHash("sha256").update(["host", kernel, ns].join("\0")).digest("hex").slice(0, 32);

beforeEach(() => {
  observations.read.mockImplementation((file: string) => file === "/etc/machine-id" ? "a".repeat(32)
    : file === "/sys/class/dmi/id/product_uuid" ? physicalHost : boot);
  observations.link.mockReturnValue(namespace);
  observations.command.mockImplementation((file: string) => file.endsWith("reg.exe")
    ? `MachineGuid    REG_SZ    ${physicalHost}\r\n` : "wsl\n");
});
afterEach(() => vi.resetAllMocks());

function reboot() {
  const old = observeLinuxKernelBoot(space(), "host");
  observations.read.mockImplementation((file: string) => file === "/etc/machine-id" ? "a".repeat(32)
    : file === "/sys/class/dmi/id/product_uuid" ? physicalHost : nextBoot);
  const current = observeLinuxKernelBoot(space(nextBoot), "host");
  return { old, current };
}

describe("local Linux kernel evidence", () => {
  it.each(["wsl", "none"])("recognizes a reboot on %s with independent physical-host identity", runtime => {
    if (runtime === "none") observations.command.mockImplementation(() => { throw { status: 1, stdout: "none\n" }; });
    const { old, current } = reboot();
    expect(old).not.toBeNull();
    expect(current).not.toBeNull();
    expect(localKernelRestarted(old, space(), current, space(nextBoot))).toBe(true);
  });

  it("does not infer a reboot after importing the same distro on another Windows host", () => {
    const { old, current } = reboot();
    observations.command.mockImplementation((file: string) => file.endsWith("reg.exe")
      ? "MachineGuid REG_SZ 44444444-4444-4444-8444-444444444444\n" : "wsl");
    const imported = observeLinuxKernelBoot(space(nextBoot), "host");
    expect(imported?.machineHash).not.toBe(current?.machineHash);
    expect(localKernelRestarted(old, space(), imported, space(nextBoot))).toBe(false);
  });

  it("does not treat a concurrent namespace in this boot as a reboot", () => {
    const old = observeLinuxKernelBoot(space(), "host");
    observations.link.mockReturnValue("pid:[4026532472]");
    const currentSpace = space(boot, "pid:[4026532472]");
    expect(localKernelRestarted(old, space(), observeLinuxKernelBoot(currentSpace, "host"), currentSpace)).toBe(false);
  });

  it.each(["docker", "podman", "lxc", "systemd-nspawn"])("does not supply host reboot evidence inside %s", runtime => {
    observations.command.mockReturnValue(runtime);
    expect(observeLinuxKernelBoot(space(), "host")).toBeNull();
  });

  it.each(["", "00000000-0000-0000-0000-000000000000", "ffffffff-ffff-ffff-ffff-ffffffffffff", "malformed"])("rejects unusable host identity %j", host => {
    observations.command.mockImplementation((file: string) => file.endsWith("reg.exe") ? `MachineGuid REG_SZ ${host}\n` : "wsl");
    expect(observeLinuxKernelBoot(space(), "host")).toBeNull();
  });

  it("fails closed when WSL interop or hardware identity is unavailable", () => {
    observations.command.mockImplementation((file: string) => {
      if (file.endsWith("reg.exe")) throw new Error("interop disabled");
      return "wsl";
    });
    expect(observeLinuxKernelBoot(space(), "host")).toBeNull();
    observations.command.mockImplementation(() => { throw { code: "ENOENT" }; });
    expect(observeLinuxKernelBoot(space(), "host")).toBeNull();
  });

  it("does not attach evidence to an unrelated recorded process space", () => {
    expect(observeLinuxKernelBoot("f".repeat(32), "host")).toBeNull();
  });

  it("retains old saved controller records without fabricating cross-boot proof", () => {
    const { current } = reboot();
    expect(readLocalKernelBoot(undefined, space())).toBeNull();
    expect(localKernelRestarted(undefined, space(), current, space(nextBoot))).toBe(false);
    expect(readLocalKernelBoot({ ...current, schema: "paperclip.local_kernel.v2" }, space(nextBoot))).toBeNull();
    expect(readLocalKernelBoot(current, "remote")).toBeNull();
  });
});