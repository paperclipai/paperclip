import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REMOTE_RECOVERY_MARKER_READ_SCRIPT, REMOTE_RECOVERY_PROCESS_CHECK_SCRIPT, REMOTE_RUNNER_EXIT_EVIDENCE_MAX_CHARS,
  REMOTE_RUNNER_EXIT_EVIDENCE_SCRIPT, RemoteRunnerRecoveryError, boundRemoteRunnerExitEvidence, describeExitedRemoteRunnerReason,
  readRemoteRunnerRecoveryDiagnostic, readRemoteRunnerRecoveryError,
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

describe("exited remote runner evidence", () => {
  it("prints bounded tails of the exit diagnostic and redirected stderr, never through a symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "remote-exit-evidence-"));
    const directory = join(root, "diagnostics");
    try {
      expect(execFileSync("sh", ["-c", REMOTE_RUNNER_EXIT_EVIDENCE_SCRIPT, "t", directory], { encoding: "utf8" })).toBe("");
      await mkdir(directory);
      await writeFile(join(directory, "runnerd.stderr.log"), "paperclip-runnerd: transport reconnect grace exceeded");
      await writeFile(join(directory, "runnerd.process-stderr.log"), `${"x".repeat(10_000)}\nlast stderr line`);
      const output = execFileSync("sh", ["-c", REMOTE_RUNNER_EXIT_EVIDENCE_SCRIPT, "t", directory], { encoding: "utf8" });
      expect(output).toContain("== runnerd.stderr.log\npaperclip-runnerd: transport reconnect grace exceeded");
      expect(output).toContain("== runnerd.process-stderr.log\n");
      expect(output).toContain("last stderr line");
      expect(output.length).toBeLessThan(4_200);
      // Each file keeps its share: a long stderr tail cannot crowd out the exit diagnostic.
      const bounded = boundRemoteRunnerExitEvidence(output, text => text)!;
      expect(bounded.length).toBeLessThanOrEqual(REMOTE_RUNNER_EXIT_EVIDENCE_MAX_CHARS);
      expect(bounded).toContain("paperclip-runnerd: transport reconnect grace exceeded");
      expect(bounded).toContain("last stderr line");
      // The first candidate directory with evidence wins; a later shared directory is read only when it has none.
      const shared = join(root, "shared");
      await mkdir(shared);
      await writeFile(join(shared, "runnerd.stderr.log"), "shared runner exit");
      expect(execFileSync("sh", ["-c", REMOTE_RUNNER_EXIT_EVIDENCE_SCRIPT, "t", directory, shared], { encoding: "utf8" })).not.toContain("shared runner exit");
      expect(execFileSync("sh", ["-c", REMOTE_RUNNER_EXIT_EVIDENCE_SCRIPT, "t", join(root, "missing"), shared], { encoding: "utf8" }))
        .toBe("== runnerd.stderr.log\nshared runner exit\n");
      await writeFile(join(root, "secret"), "private");
      await rm(join(directory, "runnerd.stderr.log"));
      await symlink(join(root, "secret"), join(directory, "runnerd.stderr.log"));
      expect(execFileSync("sh", ["-c", REMOTE_RUNNER_EXIT_EVIDENCE_SCRIPT, "t", directory], { encoding: "utf8" })).not.toContain("private");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("names the durable exit reason, redacted and bounded", () => {
    const redact = (text: string) => text.replaceAll("sk-secret", "[redacted]");
    expect(describeExitedRemoteRunnerReason({ lifecycle: "suspended", recoverableFailure: "transport_reconnect_grace_exceeded",
      diagnostics: ["a", "b", "c", "d", "token sk-secret", 7] }, redact)).toEqual({
      runnerRecoverableFailure: "transport_reconnect_grace_exceeded", runnerDiagnostics: ["b", "c", "d", "token [redacted]"] });
    expect(describeExitedRemoteRunnerReason({ recoverableFailure: "free text with spaces" }, redact)).toEqual({});
    expect(describeExitedRemoteRunnerReason(null, redact)).toEqual({});
    expect(boundRemoteRunnerExitEvidence("  ", redact)).toBeNull();
    expect(boundRemoteRunnerExitEvidence("y".repeat(9_000), redact)!.length).toBeLessThanOrEqual(REMOTE_RUNNER_EXIT_EVIDENCE_MAX_CHARS);
  });

  it("keeps the exit reason through the recorded event payload", () => {
    const diagnostic = { stage: "process_verification", reason: "process_not_running", runnerLifecycle: "ready", runnerSettled: false,
      runnerRecoverableFailure: "lease_expired_requires_bootstrap", runnerDiagnostics: ["connection lease expired"],
      runnerExitEvidence: "== runnerd.stderr.log\npaperclip-runnerd: connection lease expired" };
    expect(readRemoteRunnerRecoveryDiagnostic(JSON.parse(JSON.stringify(diagnostic)))).toEqual(diagnostic);
    expect(readRemoteRunnerRecoveryDiagnostic({ ...diagnostic, runnerRecoverableFailure: "bad value", runnerDiagnostics: [1],
      runnerExitEvidence: 4 })).toEqual({ stage: "process_verification", reason: "process_not_running", runnerLifecycle: "ready", runnerSettled: false });
  });
});
