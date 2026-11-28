import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createRunnerdNativeSessionBackend } from "../backends/codex-native-backend.js";
import type { NativeExecutionInputV1 } from "../contracts/native-execution.js";
import type * as durableControlPlane from "../control-plane/durable-prp-control-plane.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { executeNativeSession } from "../native-session-runtime.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

function processState(pid: number): "alive" | "gone" {
  try { process.kill(pid, 0); } catch { return "gone"; }
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim().startsWith("Z") ? "gone" : "alive";
  } catch { return "gone"; }
}

const kill = (pid: number | null | undefined) => {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (!["ESRCH", "EPERM"].includes(String((error as NodeJS.ErrnoException).code))) throw error; }
};

it("keeps the remote Runner alive for the same-run reattachment when the turn.start command times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "runnerd-turn-start-timeout-"));
  const hangPath = join(root, "hang-turn-start");
  const identity = { runId: "run-start-timeout", sessionId: "session-start-timeout", companyId: "company-start-timeout",
    issueId: "issue-start-timeout", agentId: "agent-start-timeout" };
  const execution: NativeExecutionInputV1 = {
    schema: "paperclip.native-execution-input.v1",
    binding: { runId: identity.runId, companyId: identity.companyId, issueId: identity.issueId, agentId: identity.agentId,
      executionWorkspaceId: "workspace-start-timeout" },
    session: { normalizedSessionId: identity.sessionId, driverKind: "codex_app_server", protocolVersion: 1,
      lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    task: { identifier: "TEST-8", title: "Write the brief", description: null, prompt: "Write the brief.", workMode: "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    provider: { kind: "codex", model: null },
    completionContract: { id: "contract-start-timeout", sha256: "digest", schemaVersion: "paperclip.completion-contract.v1", contract: {
      revision: "1", objective: "Write the brief", criteria: [{ id: "brief", requirement: "Write the brief" }],
    } },
    interactionResponses: [], credentialBindings: [],
  };
  const children: ReturnType<typeof spawn>[] = [];
  const launch = vi.fn((spec: durableControlPlane.RunnerProcessLaunchSpec) => {
    const child = spawn(spec.command, [...spec.args], { cwd: spec.cwd, env: spec.environment, stdio: "ignore" });
    children.push(child);
    return {
      child,
      completion: new Promise<durableControlPlane.RunnerProcessResult>((resolveExit, rejectExit) => {
        child.once("error", rejectExit);
        child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal, stdout: "", stderr: "" }));
      }),
      isExitConfirmed: () => child.exitCode !== null || child.signalCode !== null,
    };
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root, "--hang-turn-start", hangPath), stateDirectory: root,
    runnerReconnectGraceMs: 60_000, runnerProcessLauncher: launch, closeGraceMs: 600, turnStartTimeoutMs: 2_000,
    prpIdentity: { runnerInstanceId: "runner-start-timeout", environmentLeaseId: "lease-start-timeout", runId: identity.runId,
      normalizedSessionId: identity.sessionId, turnId: "turn-start-timeout", itemId: "item-start-timeout" },
  });
  const events: PrpEvent[] = [];
  try {
    await writeFile(hangPath, "before");
    const backend = createRunnerdNativeSessionBackend(execution, { runnerInstanceId: "runner-start-timeout",
      transportFactory: () => bundle.transport });
    const executing = executeNativeSession({
      input: execution, backend, runnerInstanceId: "runner-start-timeout", controlPlaneInstanceId: "controller-start-timeout",
      timeoutMs: 20_000, requireSessionCloseBeforeReturn: true,
      controlPlane: {
        async openRun() {},
        async checkpointSession() {},
        async appendEvent(event) {
          if (!("sourceSeq" in event)) throw new Error("Expected a durable PRP event");
          events.push(event);
          return { cursor: events.length, highestContiguousSourceSeq: event.sourceSeq, disposition: "committed" };
        },
        async replayEvents(request) {
          const source = events.filter(event => event.sourceInstanceId === request.sourceInstanceId);
          return { events: source.filter(event => event.sourceSeq > request.afterSourceSeq),
            highestContiguousSourceSeq: source.at(-1)?.sourceSeq ?? 0 };
        },
        async completeRun() {},
      },
    });
    await expect(executing).rejects.toThrow("provider_transport_failed: PRP command turn.start timed out");
    expect(launch).toHaveBeenCalledTimes(1);
    const runner = children[0]!;
    await new Promise(resolveWait => setTimeout(resolveWait, 1_000));
    expect(processState(runner.pid!)).toBe("alive");
    const journal = JSON.parse(await readFile(join(root, "runner", "runner-state.json"), "utf8")) as Record<string, unknown>;
    expect(journal.lifecycle).toBe("ready");
  } finally {
    await rm(hangPath, { force: true });
    for (const child of children) kill(child.pid);
    kill(bundle.evidence().codexPid);
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
