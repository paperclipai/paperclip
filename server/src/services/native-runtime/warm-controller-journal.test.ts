import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkpoints = vi.hoisted(() => new Map<string, string>());
vi.mock("./native-runner-checkpoint.js", () => ({
  loadNativeRunnerCheckpoint: vi.fn(async (_db: unknown, binding: { runId: string }) => {
    const state = checkpoints.get(binding.runId);
    if (state === undefined) return null;
    const parsed = JSON.parse(state) as { identity: unknown; commands: Array<{ controllerSeq: number }> };
    return {
      recoveryEvidence: { normalizedSessionId: "session" },
      records: new Map<string, string>([["header", JSON.stringify({ schema: "paperclip.runner.controller-checkpoint.v2", state: { identity: parsed.identity } })],
        ...parsed.commands.map(entry => [`command:${entry.controllerSeq}`, JSON.stringify(entry)] as [string, string])]),
      restoreSessionDirectory(root: string) {
        mkdirSync(join(root, "control-plane"), { recursive: true });
        writeFileSync(join(root, "control-plane", "control-plane-state.json"), state);
      },
    };
  }),
}));

const { CONTROLLER_JOURNAL_BEHIND_RUNNER, reconcileControllerJournalWithRunner, refreshRetiredWarmOwnerProjection } =
  await import("./warm-controller-journal.js");

const identity = { runId: "run-a", runnerInstanceId: "runner", environmentLeaseId: "lease", normalizedSessionId: "session",
  turnId: "turn", itemId: "item" };
const drainId = `command_close_drain_${"d".repeat(32)}`;
const suspendId = `command_close_suspend_${"e".repeat(32)}`;

function command(controllerSeq: number, type: string, commandId = `command_prp_${String(controllerSeq).padStart(8, "0")}`) {
  return { schema: "paperclip.prp.command.v1", commandId, controllerSeq, type, issuedAt: "2026-11-11T00:00:00.000Z",
    payload: {}, status: "completed", result: null };
}

function control(commands: ReturnType<typeof command>[]) {
  return JSON.stringify({ schema: "paperclip.runner.durable.control-plane-state.v1", identity, commands, committedEvents: [] });
}

const opened = [command(1, "run.prepare"), command(2, "session.open"), command(3, "turn.start")];
const closed = [...opened, command(4, "runner.drain", drainId), command(5, "runner.suspend", suspendId)];

function runner(processed: Array<{ commandId: string; controllerSeq: number; commandType: string; status?: string }>) {
  return { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended",
    lastControllerCommandSeq: Math.max(...processed.map(entry => entry.controllerSeq)),
    processedCommands: Object.fromEntries(processed.map(entry => [entry.commandId, { status: "completed", ...entry }])) };
}

const processedClose = [...opened.map(entry => ({ commandId: entry.commandId, controllerSeq: entry.controllerSeq, commandType: entry.type })),
  { commandId: drainId, controllerSeq: 4, commandType: "runner.drain" }, { commandId: suspendId, controllerSeq: 5, commandType: "runner.suspend" }];

describe("warm controller journal", () => {
  let root: string;
  let statePath: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "warm-controller-journal-"));
    statePath = join(root, "control-plane", "control-plane-state.json");
    mkdirSync(join(root, "control-plane"), { recursive: true });
    checkpoints.clear();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const input = () => ({ db: {} as never, root, normalizedSessionId: "session",
    binding: { companyId: "company", issueId: "issue", runId: "run-a" },
    readControlState: () => existsSync(statePath) ? readFileSync(statePath, "utf8") : null });
  const projectedTypes = () => (JSON.parse(readFileSync(statePath, "utf8")).commands as Array<{ type: string }>).map(entry => entry.type);

  it("refreshes a retired owner's projection with the close it saved after admission projected it", async () => {
    writeFileSync(statePath, control(opened));
    checkpoints.set("run-a", control(closed));
    await expect(refreshRetiredWarmOwnerProjection(input())).resolves.toBe("refreshed");
    expect(projectedTypes().slice(-2)).toEqual(["runner.drain", "runner.suspend"]);
  });

  it("holds a retired owner's projection whose saved journal diverges instead of choosing one", async () => {
    writeFileSync(statePath, control(opened));
    checkpoints.set("run-a", control([opened[0], command(2, "session.open", "command_other")]));
    await expect(refreshRetiredWarmOwnerProjection(input())).rejects.toThrow("native_runner_checkpoint_projection_held:retired_owner_journal_diverged");
    expect(projectedTypes()).toEqual(["run.prepare", "session.open", "turn.start"]);
  });

  it("leaves another run's projection and a marker untouched", async () => {
    writeFileSync(statePath, JSON.stringify({ schema: "paperclip.runner.external-control-plane-state.v1", identity }));
    checkpoints.set("run-a", control(closed));
    await expect(refreshRetiredWarmOwnerProjection(input())).resolves.toBe("unchanged");
    writeFileSync(statePath, control(opened));
    await expect(refreshRetiredWarmOwnerProjection({ ...input(), binding: { ...input().binding, runId: "run-b" } })).resolves.toBe("unchanged");
    expect(projectedTypes()).toHaveLength(3);
  });

  it("reconciles a saved journal that is behind the runner only by the predecessor's settled close", async () => {
    writeFileSync(statePath, control(opened));
    checkpoints.set("run-a", control(closed));
    await expect(reconcileControllerJournalWithRunner({ ...input(), runnerState: runner(processedClose) })).resolves.toBe("reconciled");
    expect(projectedTypes()).toEqual(closed.map(entry => entry.type));
  });

  it("refuses with a precise code when the canonical journal cannot prove the runner's close", async () => {
    writeFileSync(statePath, control(opened));
    checkpoints.set("run-a", control(opened));
    await expect(reconcileControllerJournalWithRunner({ ...input(), runnerState: runner(processedClose) })).rejects.toThrow(CONTROLLER_JOURNAL_BEHIND_RUNNER);
    expect(projectedTypes()).toHaveLength(3);
  });

  it("refuses with a precise code when the runner is ahead by anything other than a settled close", async () => {
    writeFileSync(statePath, control(opened.slice(0, 2)));
    checkpoints.set("run-a", control(closed));
    await expect(reconcileControllerJournalWithRunner({ ...input(), runnerState: runner(processedClose) })).rejects.toThrow(CONTROLLER_JOURNAL_BEHIND_RUNNER);
  });

  it("leaves a current journal and a live runner without a closing suspend to the existing admission checks", async () => {
    writeFileSync(statePath, control(closed));
    await expect(reconcileControllerJournalWithRunner({ ...input(), runnerState: runner(processedClose) })).resolves.toBe("unchanged");
    writeFileSync(statePath, control(opened.slice(0, 2)));
    const live = runner(processedClose.slice(0, 3));
    await expect(reconcileControllerJournalWithRunner({ ...input(), runnerState: live })).resolves.toBe("unchanged");
  });
});
