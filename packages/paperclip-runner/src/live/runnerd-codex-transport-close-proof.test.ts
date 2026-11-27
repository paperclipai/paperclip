import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { NativeSessionCloseUnrecoverableError } from "../contracts/native-session-backend.js";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { codexSemanticToolSpecs } from "../drivers/codex/codex-app-server-driver.js";
import { createCapabilityRunnerdCodexTransport } from "./runnerd-codex-transport.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";

const pause = (ms: number) => new Promise<void>(resolveWait => setTimeout(resolveWait, ms));

function identityFor(label: string) {
  return {
    runnerInstanceId: `runner-${label}`,
    environmentLeaseId: `lease-${label}`,
    runId: `run-${label}`,
    normalizedSessionId: `session-${label}`,
    turnId: `turn-${label}`,
    itemId: `item-${label}`,
  };
}

function settlementOf(diagnostics: readonly string[]) {
  const line = diagnostics.find(message => message.startsWith("native_session_settlement_incomplete "));
  return line ? JSON.parse(line.slice("native_session_settlement_incomplete ".length)) as Record<string, unknown> : null;
}

it("proves a completed suspend on its own read window when the durable state read outlasts the close grace", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-close-proof-slow-"));
  const identity = identityFor("close-proof-slow");
  const diagnostics: string[] = [];
  const readRunnerState = vi.fn(async () => {
    await pause(9_000);
    return { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: "suspended" };
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    closeGraceMs: 6_000,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    prpIdentity: identity,
    readRunnerState,
    onDiagnostic: message => diagnostics.push(message),
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    await expect(bundle.transport.close("warm native session idle timeout")).resolves.toBeUndefined();
    expect(settlementOf(diagnostics)).toBeNull();
    expect(readRunnerState).toHaveBeenCalled();
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

it.each([
  { title: "retires a predecessor whose earlier close could not read its completed suspension", later: "suspended", retired: true },
  { title: "keeps a predecessor unretired when its durable state still is not suspended", later: "ready", retired: false },
] as const)("$title", async ({ later, retired }) => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "runnerd-close-proof-retry-"));
  const identity = identityFor("close-proof-retry");
  const diagnostics: string[] = [];
  let readable = false;
  const readRunnerState = vi.fn(async () => {
    if (!readable) throw new Error("remote runner state read failed");
    return { schema: "paperclip.runner.durable.state.v1", ...identity, lifecycle: later };
  });
  const bundle = createCapabilityRunnerdCodexTransport({
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    closeGraceMs: 6_000,
    closeProofReadMs: 500,
    lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
    prpIdentity: identity,
    readRunnerState,
    onDiagnostic: message => diagnostics.push(message),
  });
  bundle.transport.setServerRequestHandler(async () => ({ success: true, contentItems: [] }));
  try {
    await bundle.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: [] });
    const failed = await bundle.transport.close("warm native session idle timeout").catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NativeSessionCloseUnrecoverableError);
    expect((failed as NativeSessionCloseUnrecoverableError).settlement).toMatchObject({
      runnerSuspended: false,
      suspensionState: { commandStatus: "completed" },
    });
    readable = true;
    const successor = bundle.transport.close("warm Runner held the sandbox Runner port for another session");
    if (retired) {
      await expect(successor).resolves.toBeUndefined();
      expect(diagnostics.join("\n")).toContain("runner suspension proven from its durable state");
      await expect(bundle.transport.close()).resolves.toBeUndefined();
    } else {
      const unproven = await successor.catch((error: unknown) => error);
      expect(unproven).toBeInstanceOf(NativeSessionCloseUnrecoverableError);
      expect((unproven as NativeSessionCloseUnrecoverableError).settlement).toMatchObject({
        runnerSuspended: false,
        timings: expect.objectContaining({ suspendMs: expect.any(Number), lateProofReadMs: expect.any(Number), totalMs: expect.any(Number) }),
      });
    }
  } finally {
    await bundle.transport.close().catch(() => undefined);
    await rm(stateDirectory, { recursive: true, force: true });
  }
}, 30_000);

async function adoptedIdleRunnerClosesWithSlowLivenessProbe(label: string, probeDelayMs: number) {
  const stateDirectory = await mkdtemp(join(tmpdir(), `runnerd-close-proof-${label}-`));
  const server = createServer();
  let authority = null as DurablePrpControlPlane | null;
  server.on("upgrade", (request, socket, head) => {
    if (!authority) {
      socket.destroy();
      return;
    }
    authority.handleUpgrade(request, socket, "/runner", head);
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected close proof listener");
  const registration = async (next: DurablePrpControlPlane) => {
    authority = next;
    return {
      connectUrl: `ws://127.0.0.1:${address.port}/runner`,
      release: async () => {
        if (authority === next) authority = null;
      },
    };
  };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(),
    codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(stateDirectory),
    stateDirectory,
    prpIdentity: identityFor(label),
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 },
    controlPlaneRegistration: registration,
  };
  const first = createCapabilityRunnerdCodexTransport(options);
  let adopted: ReturnType<typeof createCapabilityRunnerdCodexTransport> | null = null;
  let runnerPid: number | null = null;
  const diagnostics: string[] = [];
  try {
    const opened = await first.transport.request("thread/start", { cwd: tmpdir(), dynamicTools: codexSemanticToolSpecs() });
    runnerPid = first.evidence().runnerPid;
    const startedAt = first.transport.processInfo!().startedAt;
    await first.detachControllerForRestart();
    const controlPlaneStatePath = join(stateDirectory, "control-plane", "control-plane-state.json");
    const controlPlaneState = JSON.parse(await readFile(controlPlaneStatePath, "utf8")) as { committedEvents: Array<{ eventType: string }> };
    controlPlaneState.committedEvents = controlPlaneState.committedEvents.filter(event =>
      !["harness.ready", "session.started", "session.resumed"].includes(event.eventType));
    await writeFile(controlPlaneStatePath, `${JSON.stringify(controlPlaneState, null, 2)}\n`, { mode: 0o600 });
    const thread = opened.thread as Record<string, unknown>;
    let slowProbes = false;
    const pid = runnerPid!;
    adopted = createCapabilityRunnerdCodexTransport({
      ...options,
      closeGraceMs: 6_000,
      onDiagnostic: message => diagnostics.push(message),
      resumeDynamicTools: [],
      resumeProviderSession: { driverSessionId: String(thread.id), providerSessionId: String(thread.sessionId) },
      runnerProcessLauncher: () => { throw new Error("duplicate runner spawn attempted"); },
      adoptExistingRunner: {
        pid,
        processGroupId: pid,
        startedAt,
        signal: () => true,
        isAlive: async () => {
          if (slowProbes) await pause(probeDelayMs);
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        },
      },
    });
    await adopted.transport.request("thread/read", {});
    slowProbes = true;
    const closed = await adopted.transport.close("warm native session idle timeout", { retainUnsettledRemoteRunner: true })
      .then(() => null, (error: unknown) => error);
    const state = JSON.parse(await readFile(join(stateDirectory, "runner", "runner-state.json"), "utf8")) as Record<string, unknown>;
    return { closed, lifecycle: state.lifecycle, settlement: settlementOf(diagnostics) };
  } finally {
    await adopted?.transport.close().catch(() => undefined);
    if (runnerPid) {
      try { process.kill(runnerPid, "SIGKILL"); } catch { /* already gone */ }
    }
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

it("suspends five adopted idle Runners whose liveness probes stall together, instead of spending the close on the probe", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    adoptedIdleRunnerClosesWithSlowLivenessProbe(`adopted-${index}`, 10_000)));
  for (const result of results) {
    expect(result.closed).toBeNull();
    expect(result.lifecycle).toBe("suspended");
    expect(result.settlement).toBeNull();
  }
}, 120_000);
