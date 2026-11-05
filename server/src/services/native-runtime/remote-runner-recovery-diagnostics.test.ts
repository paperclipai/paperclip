import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REMOTE_RECOVERY_MARKER_READ_SCRIPT, REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT,
  RemoteRunnerRecoveryError, readRemoteRunnerRecoveryError,
} from "./remote-runner-recovery-diagnostics.js";

function shellExit(script: string, args: string[]) {
  try {
    execFileSync("sh", ["-c", script, "recovery-test", ...args], { stdio: "pipe", timeout: 2_000 });
    return 0;
  } catch (error) {
    return (error as { status: number }).status;
  }
}

describe("remote recovery diagnostic shell receipts", () => {
  it("keeps permission-denied liveness uncertain", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-probe-denied-"));
    const marker = join(root, "marker");
    const hook = join(root, "denied.cjs");
    try {
      await writeFile(marker, `nonce\n${process.pid}\n2026-10-26T00:00:00.000Z\nrunner\n`);
      await writeFile(hook, 'process.kill = () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); };');
      const script = `NODE_OPTIONS="--require=${hook}"; export NODE_OPTIONS; kill() { return 1; }; ` + REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT;
      expect(shellExit(script, [marker, "nonce", "runner", String(process.pid)])).toBe(46);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { fingerprint: "linux:abcd-1234:100", code: 45 },
    { fingerprint: "linux:abcd-1234:101", code: 47 },
    { fingerprint: "", code: 44 },
  ])("requires the saved generation before accepting a zombie receipt (%j)", async ({ fingerprint, code }) => {
    const root = await mkdtemp(join(tmpdir(), "remote-probe-zombie-"));
    const marker = join(root, "marker");
    try {
      await writeFile(marker, `nonce\n${process.pid}\n2026-10-26T00:00:00.000Z\nrunner\n`);
      await writeFile(join(root, "cmdline"), "");
      await writeFile(join(root, "stat"), `${process.pid} (runner (child)) ${["Z", ...Array(18).fill("0"), 100].join(" ")}\n`);
      await writeFile(join(root, "boot_id"), "abcd-1234\n");
      const script = REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT
        .replaceAll('"/proc/$pid/cmdline"', JSON.stringify(join(root, "cmdline")))
        .replaceAll('"/proc/" + pid + "/cmdline"', JSON.stringify(join(root, "cmdline")))
        .replaceAll('"/proc/" + pid + "/stat"', JSON.stringify(join(root, "stat")))
        .replaceAll('"/proc/sys/kernel/random/boot_id"', JSON.stringify(join(root, "boot_id")));
      expect(shellExit(script, [marker, "nonce", "runner", String(process.pid), fingerprint])).toBe(code);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("distinguishes missing, unsafe and valid marker reads without exposing their contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-recovery-read-"));
    const marker = join(root, "marker");
    try {
      expect(shellExit(REMOTE_RECOVERY_MARKER_READ_SCRIPT, [marker])).toBe(31);
      await writeFile(join(root, "target"), "private marker");
      await symlink(join(root, "target"), marker);
      expect(shellExit(REMOTE_RECOVERY_MARKER_READ_SCRIPT, [marker])).toBe(32);
      await rm(marker);
      await writeFile(marker, "private marker");
      expect(shellExit(REMOTE_RECOVERY_MARKER_READ_SCRIPT, [marker])).toBe(0);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("distinguishes a torn marker from a changed identity before signalling any process", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-recovery-check-"));
    const marker = join(root, "marker");
    const args = [marker, "nonce", "runner", String(process.pid)];
    try {
      expect(shellExit(REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT, args)).toBe(41);
      await writeFile(marker, "nonce\n");
      expect(shellExit(REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT, args)).toBe(43);
      await writeFile(marker, `other-nonce\n${process.pid}\n2026-10-14T00:00:00.000Z\nrunner\n`);
      expect(shellExit(REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT, args)).toBe(44);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("reads only closed labels through bounded causes and contains hostile getters", () => {
    const diagnostic = { stage: "process_verification", reason: "process_generation_changed" } as const;
    const error = new RemoteRunnerRecoveryError(diagnostic);
    expect(readRemoteRunnerRecoveryError(new Error("private outer text", { cause: error }))).toEqual(diagnostic);
    expect(readRemoteRunnerRecoveryError(Object.assign(new Error("private"), {
      code: error.code, remoteRunnerRecovery: { stage: "private", reason: "process_generation_changed" },
    }))).toBeNull();
    expect(readRemoteRunnerRecoveryError(Object.defineProperty({}, "code", { get() { throw new Error("private"); } }))).toBeNull();
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(readRemoteRunnerRecoveryError(cyclic)).toBeNull();
  });

  it("reports a retired owned child as unavailable before checking its command line", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-recovery-retired-"));
    const marker = join(root, "marker");
    const pid = execFileSync("sh", ["-c", "printf '%s' $$"], { encoding: "utf8" }).trim();
    try {
      await writeFile(marker, `nonce\n${pid}\n2026-10-14T00:00:00.000Z\nrunner\n`);
      expect(shellExit(REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT, [marker, "nonce", "runner", pid])).toBe(45);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
