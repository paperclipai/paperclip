import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REMOTE_RECOVERY_PROCESS_FINGERPRINT_CHECK_SCRIPT, REMOTE_RECOVERY_MARKER_READ_SCRIPT, REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT,
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
  it.each(["initial", "cmdline-read", "cmdline-mismatch"])("does not confirm exit from EPERM during %s verification", async stage => {
    const root = await mkdtemp(join(tmpdir(), "remote-cmdline-eperm-"));
    const marker = join(root, "marker");
    const counter = join(root, "liveness-count");
    try {
      await writeFile(marker, `nonce\n${process.pid}\n2026-10-21T00:00:00.000Z\nrunner\n`);
      await writeFile(join(root, "cmdline"), stage === "cmdline-mismatch" ? "different-process\0" : "node\0--runner-id\0runner\0");
      const threshold = stage === "initial" ? 0 : 1;
      const script = 'liveness_dir=$6; kill() { if test -e "$liveness_dir/checked"; then return 1; fi; touch "$liveness_dir/checked"; ' + (stage === "initial" ? "return 1; " : "return 0; ") + '}; ' + (stage === "cmdline-read" ? 'tr() { return 1; }; ' : "") +
        REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT.replaceAll('"/proc/$pid/cmdline"', '"$6/cmdline"')
          .replaceAll('process.kill(Number(pid), 0)', `(() => { const fs = require("node:fs"); const path = ${JSON.stringify(counter)}; const n = fs.existsSync(path) ? Number(fs.readFileSync(path, "utf8")) : 0; fs.writeFileSync(path, String(n + 1)); if (n >= ${threshold}) throw Object.assign(new Error("denied"), { code: "EPERM" }); return process.kill(Number(pid), 0); })()`);
      expect(shellExit(script, [marker, "nonce", "runner", String(process.pid), "", root])).toBe(46);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([true, false])("rechecks disappearance when the command-line read itself fails (retired=%s)", async retired => {
    const root = await mkdtemp(join(tmpdir(), "remote-cmdline-read-race-"));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      const marker = join(root, "marker");
      await writeFile(marker, `nonce\n${child.pid}\n2026-10-21T00:00:00.000Z\nrunner\n`);
      await writeFile(join(root, "cmdline"), "node\0--runner-id\0runner\0");
      const script = 'tr() { ' + (retired ? 'kill -KILL "$expected_pid"; while kill -0 "$expected_pid" 2>/dev/null; do sleep 0.01; done; ' : '') + 'return 1; }; ' +
        REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT.replaceAll('"/proc/$pid/cmdline"', '"$6/cmdline"');
      const code = await new Promise<number | null>(resolve => execFile("sh", ["-c", script, "cmdline-race", marker, "nonce", "runner", String(child.pid), "", root], { timeout: 3_000 }, error => resolve(error ? typeof error.code === "number" ? error.code : null : 0)));
      expect(code).toBe(retired ? 45 : 46);
    } finally { child.kill("SIGKILL"); await exited; await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { state: "S", expected: "linux:test-boot:12345", code: 0 },
    { state: "Z", expected: "linux:test-boot:12345", code: 45 },
    { state: "S", expected: "linux:other-boot:12345", code: 47 },
    { state: "S", expected: "linux:test-boot:12346", code: 47 },
    { state: "S", expected: "linux:test-boot:12345", code: 46, missing: true },
    { state: "S", expected: "linux:test-boot:12345", code: 46, missing: true, denied: true },
  ])("verifies fingerprint reads without inferring exit from read failures: %j", async testCase => {
    const root = await mkdtemp(join(tmpdir(), "remote-fingerprint-receipt-"));
    const pid = String(process.pid);
    const fields = [testCase.state, ...Array(18).fill("0"), "12345"];
    try {
      await writeFile(join(root, "boot_id"), "test-boot\n");
      if (!testCase.missing) await writeFile(join(root, "stat"), `${pid} (runner (worker)) ${fields.join(" ")}\n`);
      const script = 'set -eu; pid=$4; ' + REMOTE_RECOVERY_PROCESS_FINGERPRINT_CHECK_SCRIPT
        .replaceAll('"/proc/" + pid + "/stat"', JSON.stringify(join(root, "stat")))
        .replaceAll('"/proc/sys/kernel/random/boot_id"', JSON.stringify(join(root, "boot_id")))
        .replaceAll('process.kill(Number(pid), 0)', testCase.denied
          ? '(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); })()'
          : 'process.kill(Number(pid), 0)');
      expect(shellExit(script, ["marker", "nonce", "runner", pid, testCase.expected])).toBe(testCase.code);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([true, false])("rechecks liveness after command-line mismatch (retired=%s)", async (retired) => {
    const root = await mkdtemp(join(tmpdir(), "remote-recovery-exit-race-"));
    const marker = join(root, "marker");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      await writeFile(marker, `nonce\n${child.pid}\n2026-10-14T00:00:00.000Z\nrunner\n`);
      await writeFile(join(root, "cmdline"), "different-process\0");
      const retireOnRead = retired
        ? 'tr() { kill -KILL "$expected_pid"; while kill -0 "$expected_pid" 2>/dev/null; do sleep 0.01; done; }; '
        : "";
      const script = retireOnRead + REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT.replaceAll('"/proc/$pid/cmdline"', '"$6/cmdline"');
      const code = await new Promise<number | null>(resolve => execFile("sh", ["-c", script, "recovery-race", marker, "nonce", "runner", String(child.pid), "", root], { timeout: 3_000 }, error => resolve(error ? typeof error.code === "number" ? error.code : null : 0)));
      expect(code).toBe(retired ? 45 : 44);
    } finally {
      child.kill("SIGKILL");
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("confirms disappearance if the owned process is reaped during the zombie probe", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-recovery-reaped-"));
    const marker = join(root, "marker");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    try {
      await writeFile(marker, `nonce\n${child.pid}\n2026-10-21T00:00:00.000Z\nrunner\n`);
      await writeFile(join(root, "cmdline"), "");
      const script = 'node() { case "$2" in *readFileSync*) kill -KILL "$expected_pid"; while kill -0 "$expected_pid" 2>/dev/null; do sleep 0.01; done ;; esac; command node "$@"; }; ' +
        REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT.replaceAll('"/proc/$pid/cmdline"', '"$6/cmdline"')
          .replaceAll('"/proc/" + pid + "/stat"', JSON.stringify(join(root, "missing-stat")));
      const code = await new Promise<number | null>(resolve => execFile("sh", ["-c", script, "recovery-reaped", marker, "nonce", "runner", String(child.pid), "linux:boot:123", root], { timeout: 3_000 }, error => resolve(error ? typeof error.code === "number" ? error.code : null : 0)));
      expect(code).toBe(45);
    } finally {
      child.kill("SIGKILL");
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { state: "Z", expected: "linux:test-boot:12345", code: 45 },
    { state: "Z", expected: "linux:other-boot:12345", code: 47 },
    { state: "Z", expected: "linux:test-boot:12346", code: 47 },
    { state: "Z", expected: "", code: 44 },
    { state: "S", expected: "linux:test-boot:12345", code: 44 },
    { state: "R", expected: "linux:test-boot:12345", code: 44 },
    { state: "Z", expected: "linux:test-boot:12345", code: 46, malformed: true },
    { state: "Z", expected: "linux:test-boot:12345", code: 46, missing: true },
    { state: "Z", expected: "linux:test-boot:12345", code: 46, missing: true, permissionDenied: true },
    { state: "Z", expected: "linux:test-boot:12345", code: 44, wrongNonce: true },
  ])("requires an owned, generation-matched zombie receipt: %j", async (testCase) => {
    const root = await mkdtemp(join(tmpdir(), "remote-recovery-zombie-"));
    const marker = join(root, "marker");
    const pid = String(process.pid);
    const fields = Array.from({ length: 20 }, () => "0");
    fields[0] = testCase.state;
    fields[19] = "12345";
    try {
      await writeFile(marker, `${testCase.wrongNonce ? "wrong" : "nonce"}\n${pid}\n2026-10-21T00:00:00.000Z\nrunner\n`);
      await writeFile(join(root, "cmdline"), "");
      await writeFile(join(root, "boot_id"), "test-boot\n");
      if (!testCase.missing) await writeFile(join(root, "stat"), testCase.malformed ? "invalid" : `${pid} (runner (worker)) ${fields.join(" ")}\n`);
      const script = REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT
        .replaceAll('"/proc/$pid/cmdline"', '"$6/cmdline"')
        .replaceAll('"/proc/" + pid + "/stat"', JSON.stringify(join(root, "stat")))
        .replaceAll('"/proc/sys/kernel/random/boot_id"', JSON.stringify(join(root, "boot_id")))
        .replaceAll('process.kill(Number(pid), 0)', testCase.permissionDenied
          ? '(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); })()'
          : 'process.kill(Number(pid), 0)');
      expect(shellExit(script, [marker, "nonce", "runner", pid, testCase.expected, root])).toBe(testCase.code);
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
      await writeFile(marker, `nonce\n${process.pid}\n2026-10-14T00:00:00.000Z\nother-runner\n`);
      expect(shellExit(REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT, args)).toBe(44);
      await writeFile(join(root, "target"), `nonce\n${process.pid}\n2026-10-14T00:00:00.000Z\nrunner\n`);
      await rm(marker);
      await symlink(join(root, "target"), marker);
      expect(shellExit(REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT, args)).toBe(42);
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
