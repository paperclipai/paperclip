import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

const signalGroup = (pid: number, signal: NodeJS.Signals) => {
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
};

// Chaos w-20261111T011704-s9107/t05: the control plane and its Runner tree were
// stopped (SIGSTOP, a host-sleep stand-in) for 61 s while turn.start waited on its
// 30 s deadline. On thaw the wall clock had passed the deadline before either
// process could act, and the run reported "PRP command turn.start timed out".
// This drives the real transport and Runner: it fails if turn start does not run
// on the stopped-time clock, or if its waits do not read that clock.
it("starts a turn whose Runner and control plane were stopped past the turn-start deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-turn-start-stall-"));
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root),
    stateDirectory: root,
    turnStartTimeoutMs: 30_000,
    prpIdentity: {
      runnerInstanceId: "stall-runner", environmentLeaseId: "stall-lease", runId: "stall-run",
      normalizedSessionId: "stall-session", turnId: "stall-turn", itemId: "stall-item",
    },
  });
  const realNow = Date.now.bind(Date);
  let stoppedMs = 0;
  let runnerPid: number | null = null;
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    runnerPid = bundle.evidence().runnerPid;
    expect(runnerPid).toEqual(expect.any(Number));
    // Stop the Runner tree, then let this process "sleep" 40 s: the wall clock
    // jumps while no timer of this process runs.
    signalGroup(runnerPid!, "SIGSTOP");
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + stoppedMs);
    const started = bundle.transport.request("turn/start", { input: [{ type: "text", text: "Continue after the freeze." }] });
    await new Promise(resolve => setTimeout(resolve, 300));
    stoppedMs = 40_000;
    await new Promise(resolve => setTimeout(resolve, 300));
    signalGroup(runnerPid!, "SIGCONT");
    await expect(started).resolves.toMatchObject({ turn: { status: "inProgress" } });
  } finally {
    vi.restoreAllMocks();
    if (runnerPid !== null) signalGroup(runnerPid, "SIGCONT");
    await bundle.transport.close().catch(() => undefined);
    if (runnerPid !== null) signalGroup(runnerPid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
