import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withRemoteRunnerTurnProof } from "./native-session-executor.js";
import { RemoteRunnerRecoveryError, readRemoteRunnerRecoveryError } from "./remote-runner-recovery-diagnostics.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function journal(commands: Array<{ type: string; status: string }>, eventTypes = ["session.started"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "turn-proof-"));
  roots.push(root);
  await mkdir(path.join(root, "control-plane"), { recursive: true });
  await writeFile(path.join(root, "control-plane", "control-plane-state.json"), JSON.stringify({
    schema: "paperclip.runner.durable.control-plane-state.v2", connectionCount: 1,
    commands, committedEvents: eventTypes.map((eventType, index) => ({ sourceSeq: index + 1, eventType })),
    ackedSourceSeq: eventTypes.length,
  }));
  return root;
}
const exited = () => new RemoteRunnerRecoveryError({ stage: "process_verification", reason: "process_not_running",
  runnerLifecycle: "ready", runnerSettled: false });

// Staging class T: the Runner process was proven gone. Only the controller
// journal, which records each turn command before sending it, can prove no
// turn was issued; an absence of run events cannot.
describe("withRemoteRunnerTurnProof", () => {
  it("records the proof when the journal holds only session commands", async () => {
    const root = await journal([{ type: "run.prepare", status: "completed" }, { type: "session.open", status: "completed" },
      { type: "session.snapshot", status: "pending" }]);
    expect(readRemoteRunnerRecoveryError(withRemoteRunnerTurnProof(exited(), root))).toMatchObject({
      reason: "process_not_running", providerTurnIssued: false });
  });

  it.each([
    ["a turn command was issued", [{ type: "session.open", status: "completed" }, { type: "turn.start", status: "pending" }], ["session.started"]],
    ["a turn event was committed", [{ type: "session.open", status: "completed" }], ["session.started", "turn.started"]],
  ])("records nothing when %s", async (_label, commands, events) => {
    const root = await journal(commands, events);
    expect(readRemoteRunnerRecoveryError(withRemoteRunnerTurnProof(exited(), root))).not.toHaveProperty("providerTurnIssued");
  });

  it("records nothing without a readable journal or without a proven exit", async () => {
    const empty = await mkdtemp(path.join(os.tmpdir(), "turn-proof-"));
    roots.push(empty);
    expect(readRemoteRunnerRecoveryError(withRemoteRunnerTurnProof(exited(), empty))).not.toHaveProperty("providerTurnIssued");
    const root = await journal([{ type: "session.open", status: "completed" }]);
    const unreachable = new RemoteRunnerRecoveryError({ stage: "process_verification", reason: "probe_transport_failed" });
    expect(readRemoteRunnerRecoveryError(withRemoteRunnerTurnProof(unreachable, root))).not.toHaveProperty("providerTurnIssued");
  });
});
