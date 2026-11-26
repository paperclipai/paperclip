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
