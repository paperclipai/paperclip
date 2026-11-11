import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCommand } from "./config.js";
import { DISK_FULL_REST_SETTLE_MS, DiskFullFaultSeam, diskFullLedger, diskFullRest, diskFullRestReady, receiptsForIssue, withDiskFullCheck } from "./disk-full-faults.js";
import { gradeR3 } from "./grader.js";
import { planTasks, taskFaultSchedule } from "./scheduler.js";
import type { TaskRecord } from "./types.js";

const IMAGE = `ghcr.io/paperclipai/paperclip-daytona-runner@sha256:${"a".repeat(64)}`;
const diskFullIssue = (label = "sandbox_disk_full", canRetry = true) => ({
  status: "blocked", interruption: { canRetry },
  activeRecoveryAction: { ownerType: "board", evidence: { systemRecovery: { failure: {
    code: "export_interrupted", retryClass: "user_action_required", cause: { label, code: "ENOSPC", status: null } } } } },
});

function record(extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    plan: { taskId: "t01", index: 0, workload: "B1", adapter: "codex", fault: "DF1", fireAfterMs: 0, holdMs: 0, followUpAfterMs: null, nonce: "abcd1234" },
    issueId: "issue-1", identifier: "CHA-1", createdAt: 0, launchError: null, samples: [], retry: null, restAt: 1,
    finalStatus: "done", deadlineAt: 1, timedOut: false, followUp: null, faultIds: [], sweep: null,
    preFaultFiles: null, lostFiles: null,
    diskFull: { kind: "DF1", armedAt: 1, clearedAt: 2, rest: diskFullRest(diskFullIssue(), 2), appliedSaves: 2 },
    ...extra,
  };
}
const accepted = { at: 3, observedRunId: "run-1", httpStatus: 200, accepted: true, error: null };
const passing = { verdict: "pass" as const, checks: [] };

describe("DF1 planning", () => {
  it("is a per-task fault on Daytona that schedules no restart", () => {
    const command = parseCommand(["--env", "daytona", "--daytona-image", IMAGE, "--adapters", "codex", "--workloads", "B1",
      "--faults", "DF1", "--storage", "s3", "--tasks", "2", "--seed", "7"]);
    if (command.mode !== "wave") throw new Error("expected a wave");
    expect(command.options).toMatchObject({ faults: [], diskFullFaults: ["DF1"] });
    const tasks = planTasks(command.options);
    expect(tasks.map(task => task.fault)).toEqual(["DF1", "DF1"]);
    expect(tasks.map(taskFaultSchedule)).toEqual([[], []]);
  });

  it("refuses waves where no sandbox save exists or the plan cannot carry it", () => {
    expect(() => parseCommand(["--adapters", "codex", "--workloads", "B1", "--faults", "DF1"])).toThrow(/--env daytona/);
    expect(() => parseCommand(["--env", "daytona", "--daytona-image", IMAGE, "--adapters", "codex", "--workloads", "B1", "--faults", "DF1"])).toThrow(/--storage s3/);
    expect(() => parseCommand(["--env", "daytona", "--daytona-image", IMAGE, "--adapters", "codex", "--faults", "DF1", "--storage", "s3", "--storm-minutes", "5"]))
      .toThrow(/storm/);
    expect(() => parseCommand(["--env", "daytona", "--daytona-image", IMAGE, "--adapters", "codex", "--workloads", "B1", "--faults", "DF1", "--storage", "s3", "--matrix"]))
      .toThrow(/--matrix/);
  });
});

describe("DF1 control file", () => {
  let root: string | null = null;
  afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = null; });

  it("arms and clears issue ids atomically and reads the server's receipts", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "df1-seam-"));
    const receiptPath = path.join(root, "receipts.jsonl");
    const seam = await DiskFullFaultSeam.install({ root, receiptPath });
    expect(seam.serverEnvironment).toEqual({ PAPERCLIP_DISK_FULL_FAULT_CONTROL: seam.controlPath, PAPERCLIP_DISK_FULL_FAULT_RECEIPT: receiptPath });
    expect(await readFile(seam.controlPath, "utf8")).toBe("");
    await Promise.all([seam.arm("issue-1"), seam.arm("issue-2")]);
    expect(await readFile(seam.controlPath, "utf8")).toBe("issue-1\nissue-2\n");
    await seam.clear("issue-1");
    expect(await readFile(seam.controlPath, "utf8")).toBe("issue-2\n");
    await writeFile(receiptPath, `${JSON.stringify({ issueId: "issue-2", runId: "r", boundary: "final", pid: 1, at: "t" })}\nnot json\n`);
    expect(receiptsForIssue(await seam.receipts(), "issue-2")).toHaveLength(1);
    expect(receiptsForIssue(await seam.receipts(), "issue-1")).toHaveLength(0);
  });
});

describe("DF1 clear timing", () => {
  it("waits at an unfinished rest until the board names the full disk, then up to the settle bound", () => {
    const disk = { kind: "DF1" as const, armedAt: 1, clearedAt: null, rest: null };
    const checking = diskFullRest({ status: "blocked", interruption: { canRetry: true }, activeRecoveryAction: { ownerType: "board", evidence: {} } }, 0);
    expect(diskFullRestReady(disk, checking, 1_000)).toBe(false);
    expect(diskFullRestReady(disk, checking, 1_000 + DISK_FULL_REST_SETTLE_MS - 1)).toBe(false);
    expect(diskFullRestReady(disk, diskFullRest(diskFullIssue(), 0), 2_000)).toBe(true);
    expect(diskFullRestReady(disk, { ...checking, status: "done" }, 2_000)).toBe(true);
    expect(diskFullRestReady(disk, checking, 1_000 + DISK_FULL_REST_SETTLE_MS)).toBe(true);
  });
});

describe("DF1 grading", () => {
  it("passes when the task rested on a full disk with a Retry and one Retry finished it", () => {
    const graded = record({ retry: accepted });
    expect(withDiskFullCheck(passing, graded.plan, graded).verdict).toBe("pass");
    expect(gradeR3(graded)).toMatchObject({ verdict: "pass" });
    expect(diskFullLedger(graded, "done")).toEqual({ faultedSaves: 2, restedDiskFull: true, retryOffered: true, retryWorked: true });
  });

  it("fails a fault that never reached a save, a different rest cause, or a missing Retry", () => {
    const notApplied = record({ diskFull: { kind: "DF1", armedAt: 1, clearedAt: null, rest: null, appliedSaves: 0 } });
    expect(withDiskFullCheck(passing, notApplied.plan, notApplied).checks[0]).toMatchObject({ ok: false, detail: expect.stringContaining("not_applied") });
    const otherCause = record({ retry: accepted, diskFull: { kind: "DF1", armedAt: 1, clearedAt: 2, rest: diskFullRest(diskFullIssue("provider_error"), 2), appliedSaves: 1 } });
    expect(withDiskFullCheck(passing, otherCause.plan, otherCause).checks[0]?.detail).toContain("rest_cause=provider_error");
    const noRetryOffered = record({ diskFull: { kind: "DF1", armedAt: 1, clearedAt: 2, rest: diskFullRest(diskFullIssue("sandbox_disk_full", false), 2), appliedSaves: 1 } });
    expect(withDiskFullCheck(passing, noRetryOffered.plan, noRetryOffered).checks[0]?.detail).toContain("retry_not_offered");
    expect(gradeR3(record({ finalStatus: "blocked" }))).toMatchObject({ verdict: "fail", detail: expect.stringContaining("disk_full_retry_missing") });
  });

  it("fails a Retry that did not finish the task or needed a second click", () => {
    expect(gradeR3(record({ retry: accepted, finalStatus: "blocked" }))).toMatchObject({ verdict: "fail", detail: expect.stringContaining("did_not_complete") });
    expect(gradeR3(record({ retry: accepted, priorRetries: [accepted] }))).toMatchObject({ verdict: "fail", detail: expect.stringContaining("2_clicks") });
    expect(gradeR3(record({ retry: { ...accepted, accepted: false } }))).toMatchObject({ verdict: "fail", detail: expect.stringContaining("retry_rejected") });
  });

  it("leaves other cells to the ordinary Retry rule", () => {
    const plain = record({ plan: { ...record().plan, fault: "K1" }, retry: accepted, diskFull: undefined });
    expect(withDiskFullCheck(passing, plain.plan, plain)).toBe(passing);
    expect(gradeR3(plain)).toMatchObject({ verdict: "fail", detail: expect.stringContaining("retry_no_new_run") });
  });
});
