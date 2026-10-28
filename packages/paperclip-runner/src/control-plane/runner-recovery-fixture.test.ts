import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it, vi } from "vitest";
import {
  DurablePrpControlPlane, decodeDurablePrpCheckpoint, type DurablePrpCheckpoint,
} from "./durable-prp-control-plane.js";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const binary = resolve(packageRoot, "runner/target/debug/examples/recovery-fixture");
const identity = {
  runnerInstanceId: "fixture-runner", environmentLeaseId: "fixture-lease",
  runId: "fixture-run", normalizedSessionId: "fixture-session", turnId: "fixture-turn", itemId: "fixture-item",
};
const expectedRunnerVersion = "0.3.0";
const expectedRunnerDigest = `sha256:${"c".repeat(64)}`;

beforeAll(() => {
  execFileSync("cargo", ["build", "--locked", "--manifest-path", resolve(packageRoot, "runner/Cargo.toml"),
    "-p", "paperclip-runner-core", "--example", "recovery-fixture"], { timeout: 120_000, stdio: "pipe" });
}, 120_000);

async function fixture(externalPersistence: boolean, graceMs = 20_000) {
  const root = mkdtempSync(resolve(tmpdir(), "runner-in-process-recovery-"));
  const stateDirectory = resolve(root, "control-plane");
  const receiptFile = resolve(root, "work.json");
  const releaseFile = resolve(root, "release");
  const scriptFile = resolve(root, "script.json");
  writeFileSync(scriptFile, JSON.stringify({ steps: 64, waitAfter: 32, retentionLimit: 8, receiptFile, releaseFile }));
  const delivered: Array<{ sourceEventId: string; text: string }> = [];
  let checkpoint: DurablePrpCheckpoint | undefined;
  const create = () => {
    const core = new DurablePrpControlPlane({ stateDirectory, identity, expectedRunnerVersion, expectedRunnerDigest,
      onCommittedEvent: async event => {
        if (event.eventType === "item.delta") delivered.push({ sourceEventId: event.sourceEventId, text: (event.payload as { text: string }).text });
      },
    });
    if (externalPersistence) core.setCheckpointPersistence(async saved => { checkpoint = saved; });
    return core;
  };
  let core = create();
  let child: ChildProcess | undefined;
  let exit: Promise<unknown[]> | undefined;
  const receipt = () => JSON.parse(readFileSync(receiptFile, "utf8")) as {
    pid: number; phase: string; completedSteps: number; retainedEvents: number; peakRetainedEvents: number; acknowledgedEvents: number;
  };
  await core.start();
  const port = Number(new URL(core.connectUrl).port);
  const ticket = core.issueBootstrapTicket();
  await core.flushCheckpoint();
  child = spawn(binary, ["--fixture-script", scriptFile, "--connect-url", core.connectUrl,
    "--state-dir", resolve(root, "runner"), "--runner-id", identity.runnerInstanceId,
    "--environment-lease-id", identity.environmentLeaseId, "--run-id", identity.runId,
    "--session-id", identity.normalizedSessionId, "--turn-id", identity.turnId, "--item-id", identity.itemId,
    "--runner-version", expectedRunnerVersion, "--runner-digest", expectedRunnerDigest,
    "--max-outbox-bytes", "65536", "--p0-reserve-bytes", "16384", "--reconnect-grace-ms", String(graceMs),
  ], { env: { ...process.env, PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: ticket }, stdio: ["ignore", "ignore", "pipe"] });
  let diagnostics = "";
  child.stderr!.on("data", bytes => { diagnostics = (diagnostics + String(bytes)).slice(-4096); });
  exit = once(child, "exit");
  async function command(type: string, commandId: string) {
    core.queueCommand(type, {}, commandId, true);
    await vi.waitFor(() => expect(core.getCommand(commandId)?.status, `${commandId}: exit=${child?.exitCode}; ${diagnostics}`).toBe("completed"), { timeout: 10_000 });
  }
  return {
    root, receipt, child, exit, delivered, command,
    checkpoint: () => checkpoint,
    release: () => writeFileSync(releaseFile, "compute"),
    stopController: async () => {
      await core.stop();
      await core.drainPendingConnectionProcessing();
      await core.flushCheckpoint();
    },
    replaceController: async () => {
      if (externalPersistence) {
        rmSync(stateDirectory, { recursive: true });
        decodeDurablePrpCheckpoint(checkpoint!.records).restoreSessionDirectory(root);
      }
      core = create();
      await core.start(port);
    },
    cleanup: async () => {
      await core.stop();
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

it.each([false, true])("preserves useful in-process work through repeated replacement (external persistence: %s)", async external => {
  const run = await fixture(external);
  try {
    await run.command("turn.start", "start-once");
    expect(run.receipt().completedSteps).toBe(0);
    await run.stopController();
    run.release();
    await vi.waitFor(() => expect(run.receipt()).toMatchObject({ phase: "backpressured", completedSteps: 8, retainedEvents: 8 }), { timeout: 5000 });
    expect(run.receipt().pid).toBe(run.child.pid);
    expect(run.child.exitCode).toBeNull();
    expect(run.delivered).toHaveLength(0);
    await run.replaceController();
    await vi.waitFor(() => expect(run.delivered).toHaveLength(32), { timeout: 10_000 });
    expect(run.receipt()).toMatchObject({ phase: "awaiting_controller", completedSteps: 32 });
    await run.stopController();
    expect(run.receipt().completedSteps).toBe(32);
    await run.replaceController();
    await run.command("session.snapshot", "after-second-replacement");
    expect(run.receipt().completedSteps).toBe(32);
    await run.command("turn.steer", "controller-dependent-continuation");
    await vi.waitFor(() => expect(run.delivered).toHaveLength(64), { timeout: 10_000 });
    expect(new Set(run.delivered.map(event => event.sourceEventId)).size).toBe(64);
    expect(run.delivered.map(event => Number(event.text.match(/^step=(\d+)/)?.[1]))).toEqual(Array.from({ length: 64 }, (_, i) => i + 1));
    // Controller delivery precedes the acknowledgement reaching the runner.
    // Prove backlog settlement at the runner before ending the experiment.
    await vi.waitFor(() => expect(run.receipt()).toMatchObject({
      phase: "completed", pid: run.child.pid, completedSteps: 64, acknowledgedEvents: 64, retainedEvents: 0,
    }), { timeout: 10_000 });
    expect(run.receipt().peakRetainedEvents).toBeLessThanOrEqual(8);
    if (external) expect([...run.checkpoint()!.records.values()].join("\n")).not.toContain("step=");
    await run.command("runner.shutdown", "shutdown");
    expect((await run.exit)[0]).toBe(0);
  } finally { await run.cleanup(); }
}, 35_000);

it("stops after the original reconnect deadline while retaining recovery state", async () => {
  const run = await fixture(true, 1500);
  try {
    await run.command("turn.start", "start-once");
    await run.stopController();
    run.release();
    await run.exit;
    const state = JSON.parse(readFileSync(resolve(run.root, "runner/runner-state.json"), "utf8"));
    expect(state.recoverableFailure).toBe("transport_reconnect_grace_exceeded");
    expect(run.receipt()).toMatchObject({ phase: "stopped", pid: run.child.pid });
    expect(run.receipt().completedSteps).toBeGreaterThan(0);
    expect(run.receipt().peakRetainedEvents).toBeLessThanOrEqual(8);
  } finally { await run.cleanup(); }
}, 15_000);
