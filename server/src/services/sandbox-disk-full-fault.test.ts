import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REMOTE_WORKSPACE_SANDBOX_DISK_FULL, captureRemoteWorkspaceArchive, type RemoteWorkspaceTarget } from "./remote-workspace-transport.js";
import {
  DISK_FULL_FAULT_CONTROL_ENV, DISK_FULL_FAULT_RECEIPT_ENV, DISK_FULL_FAULT_SYNC_OUT_MESSAGE,
  readDiskFullFaultGate, sandboxDiskFullFaultTarget, setDiskFullFaultGateForTest,
} from "./sandbox-disk-full-fault.js";

const ISSUE = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";
const OPERATION = "33333333-3333-4333-8333-333333333333";

function sandboxTarget(calls: string[]): RemoteWorkspaceTarget {
  return {
    kind: "remote", transport: "sandbox", remoteCwd: "/workspace", providerKey: "test",
    runner: {
      execute: async () => { calls.push("execute"); return { exitCode: 0, signal: null, timedOut: false, stdout: "{}", stderr: "", pid: 1, startedAt: null }; },
      syncIn: async () => { calls.push("syncIn"); return {} as never; },
      syncOut: async () => { calls.push("syncOut"); return {} as never; },
    },
  } as unknown as RemoteWorkspaceTarget;
}

describe("sandbox disk-full fault gate", () => {
  let restore: (() => void) | null = null;
  const dirs: string[] = [];
  afterEach(() => {
    restore?.(); restore = null;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = () => { const dir = mkdtempSync(path.join(os.tmpdir(), "disk-full-fault-")); dirs.push(dir); return dir; };

  it("is off unless the harness switch is set, and never on in production", () => {
    expect(readDiskFullFaultGate({})).toBeNull();
    expect(readDiskFullFaultGate({ [DISK_FULL_FAULT_CONTROL_ENV]: "  " })).toBeNull();
    expect(readDiskFullFaultGate({ NODE_ENV: "production", [DISK_FULL_FAULT_CONTROL_ENV]: "/tmp/control" })).toBeNull();
    expect(readDiskFullFaultGate({ NODE_ENV: "test", [DISK_FULL_FAULT_CONTROL_ENV]: "/tmp/control", [DISK_FULL_FAULT_RECEIPT_ENV]: "/tmp/receipt" }))
      .toEqual({ controlPath: "/tmp/control", receiptPath: "/tmp/receipt" });
  });

  it("returns the save's own target when the process was started without the switch", () => {
    const target = sandboxTarget([]);
    expect(sandboxDiskFullFaultTarget(target, { boundary: "final", issueId: ISSUE, runId: RUN })).toBe(target);
  });

  it("faults only a final save whose issue or run is listed, and stops when cleared", async () => {
    const dir = scratch();
    const control = path.join(dir, "control"), receipt = path.join(dir, "receipts.jsonl");
    restore = setDiskFullFaultGateForTest({ controlPath: control, receiptPath: receipt });
    const calls: string[] = [];
    const target = sandboxTarget(calls);
    // No control file yet: disarmed.
    expect(sandboxDiskFullFaultTarget(target, { boundary: "final", issueId: ISSUE, runId: RUN })).toBe(target);
    writeFileSync(control, `other-issue\n${ISSUE}\n`);
    expect(sandboxDiskFullFaultTarget(target, { boundary: "initial", issueId: ISSUE, runId: RUN })).toBe(target);
    expect(sandboxDiskFullFaultTarget(target, { boundary: "final", issueId: "other", runId: "other-run" })).toBe(target);

    const faulted = sandboxDiskFullFaultTarget(target, { boundary: "final", issueId: ISSUE, runId: RUN });
    expect(faulted).not.toBe(target);
    expect(await faulted.runner!.execute({ command: "node" })).toMatchObject({ exitCode: 1, stderr: REMOTE_WORKSPACE_SANDBOX_DISK_FULL });
    await expect(faulted.runner!.syncOut!([])).rejects.toThrow(DISK_FULL_FAULT_SYNC_OUT_MESSAGE);
    await faulted.runner!.syncIn!([]);
    expect(calls).toEqual(["syncIn"]);
    expect(JSON.parse(readFileSync(receipt, "utf8").trim())).toMatchObject({ issueId: ISSUE, runId: RUN, boundary: "final" });

    // The save's own capture path turns the sandbox's answer into the named disk-full failure.
    await expect(captureRemoteWorkspaceArchive({ target: faulted, remoteCwd: "/workspace", operationId: OPERATION }))
      .rejects.toThrow(REMOTE_WORKSPACE_SANDBOX_DISK_FULL);

    // A run id arms it too; clearing the file disarms the next save.
    writeFileSync(control, `${RUN}\n`);
    expect(sandboxDiskFullFaultTarget(target, { boundary: "final", issueId: null, runId: RUN })).not.toBe(target);
    writeFileSync(control, "");
    expect(sandboxDiskFullFaultTarget(target, { boundary: "final", issueId: ISSUE, runId: RUN })).toBe(target);
  });
});
