import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { appendFileSync, closeSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { QUALIFIED_ACPX_PROFILES, resolveQualifiedAcpxProfile } from "../drivers/acpx/qualified-profiles.js";
import { createCapabilityRunnerdCodexTransport, readRunnerdArtifactBinding, type CapabilityRunnerdCodexTransportOptions } from "./runnerd-codex-transport.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";
import { defaultCapabilityRunnerdBinary } from "../../test/support/runnerd-transport.js";
import type { PrpEvent } from "../protocol/replay-contract.js";
import { createNativeSessionBackend } from "../backends/native-backend-factory.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { PersistedNativeSession } from "../contracts/native-session-backend.js";

type Bundle = ReturnType<typeof createCapabilityRunnerdCodexTransport>;
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const sha = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const kill = (pid: number) => { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } };
const absent = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; } };
const stopped = (pid: number) => {
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  try { return execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim().startsWith("Z"); }
  catch (error) { if ((error as { status?: number }).status === 1) return true; throw error; }
};

async function fixture(agent: "codex" | "claude" = "codex", nativeSource = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner-acpx-source-")));
  const journal = join(root, "calls"), fault = join(root, "fault"), wrapper = join(root, "sidecar"), script = join(root, "sidecar-entry");
  const binary = defaultCapabilityRunnerdBinary(), sidecar = resolve(import.meta.dirname, "../../runner/target/debug/fake-acpx-sidecar");
  await mkdir(join(root, "acpx"), { mode: 0o700 }); await mkdir(join(root, "diagnostics"), { mode: 0o700 });
  await writeFile(script, "qualified fixture entry");
  await writeFile(wrapper, `#!/bin/sh\nexec ${quote(sidecar)} --mode source-reconcile --profile-digest ${quote(QUALIFIED_ACPX_PROFILES[agent].commandDigest)} --journal ${quote(journal)} --source-fault ${quote(fault)} --spawn-owned-child${nativeSource ? " --wait-completion-feedback" : ""}\n`, { mode: 0o700 });
  let authority: DurablePrpControlPlane | null = null;
  let registrationGeneration = 0;
  const server = createServer();
  server.on("upgrade", (request, socket, head) => authority ? authority.handleUpgrade(request, socket, "/runner", head) : socket.destroy());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture listener");
  const identity = { runnerInstanceId: "runner-source", environmentLeaseId: "lease-source", runId: "run-source", normalizedSessionId: "session-source", turnId: "turn-source", itemId: "item-source" };
  const nativeIdentity = { companyId: "company", agentId: "agent", issueId: "issue", runId: identity.runId, sessionId: identity.normalizedSessionId };
  const execution: NativeExecutionInput = { schema: "paperclip.native-execution-input.v1",
    binding: { companyId: nativeIdentity.companyId, agentId: nativeIdentity.agentId, issueId: nativeIdentity.issueId, runId: identity.runId, executionWorkspaceId: "workspace" },
    task: { identifier: "TASK-1", title: "Complete fake work", description: null, prompt: "Complete fake work", workMode: "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: identity.normalizedSessionId, driverKind: "acpx_runtime", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
    provider: { kind: "acpx", agent, model: "explicit-source-model", permissionPolicy: "interactive", profile: resolveQualifiedAcpxProfile(agent, "explicit-source-model") },
    completionContract: { id: "contract", sha256: sha("contract"), schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Complete fake work", criteria: [{ id: "objective", requirement: "Complete fake work" }] } }, interactionResponses: [], credentialBindings: [] };
  const bundles: Bundle[] = [], runnerPids = new Set<number>();
  let requirements: RunnerProviderLaunchRequirements | undefined;
  let recovering = false;
  const options: CapabilityRunnerdCodexTransportOptions = {
    provider: "acpx", acpxAgent: agent, runnerBinary: binary, stateDirectory: root, prpIdentity: identity,
    runnerArtifact: readRunnerdArtifactBinding(binary), codexSourceRecoveryVersion: 1, acpxSourceRecoveryVersion: 1,
    lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 }, runnerProcessReconnectGraceMs: null, runnerReconnectGraceMs: 3_000,
    controlPlaneRegistration: async next => {
      const generation = ++registrationGeneration; authority = next;
      return { connectUrl: `ws://127.0.0.1:${address.port}/runner`, release: () => { if (generation === registrationGeneration) authority = null; } };
    },
    prepareLaunch: async input => {
      requirements ??= structuredClone(input);
      return { configurationId: `${recovering ? "source" : "initial"}-${input.identity.runId}`, requirementsDigest: runnerLaunchRequirementsDigest(input),
        provider: createRunnerProviderLaunch(input, { options: {}, root, cwd: root, codexHome: root, codexCommand: "", providerNodeCommand: wrapper, opencodeProxyPath: "", acpxSidecarPath: script }) };
    },
    runnerProcessLauncher: spec => {
      const stderr = openSync(join(root, "native.stderr"), "a", 0o600);
      const child = spawn(binary, [...spec.args, "--acpx-launch-authority-digest", sha("fixture authority"),
        "--acpx-sidecar-command", wrapper, "--acpx-sidecar-command-sha256", sha(execFileSync("cat", [wrapper])),
        "--acpx-sidecar-script", script, "--acpx-sidecar-script-sha256", sha("qualified fixture entry")],
        { env: { PATH: process.env.PATH, HOME: root, ...spec.environment }, stdio: ["ignore", "ignore", stderr], detached: true });
      closeSync(stderr);
      if (child.pid) runnerPids.add(child.pid);
      return { child, completion: new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => {
        try { appendFileSync(join(root, "native.stderr"), readFileSync(join(root, "diagnostics", "runnerd.stderr.log"))); } catch {}
        resolve({ code, signal, stdout: "", stderr: "" });
      }); }) };
    },
  };
  const runnerFile = join(root, "runner", "runner-state.json"), providerFile = join(root, "runner", "acpx-provider-state.json"), coreFile = join(root, "control-plane", "control-plane-state.json");
  const calls = async () => (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const count = async (command: string) => (await calls()).filter(entry => command === "processStart" ? entry.processStart : entry.command === command).length;
  const settle = async () => vi.waitFor(async () => {
    const runner = await read(runnerFile), provider = await read(providerFile), core = await read(coreFile);
    expect(runner.outbox).toEqual([]); expect(runner.ackedSourceSeq).toBe(runner.nextSourceSeq - 1);
    expect(provider.activeTurnId).toBeNull(); expect(provider.pendingEvents).toEqual([]); expect(provider.pendingRuntimeRequests).toEqual({});
    expect(core.commands.some((command: { status: string }) => command.status === "pending")).toBe(false);
    expect(authority?.semanticToolResultsSettled()).toBe(true);
  }, { timeout: 5_000 });
  const complete = async (bundle: Bundle) => {
    await bundle.transport.request("turn/start", { input: [{ type: "text", text: "Complete the fake ACPX turn." }] });
    for await (const event of bundle.transport.notifications()) if (event.method === "turn/completed") return;
    throw new Error("missing completed turn");
  };
  const cleanup = async () => {
    for (const bundle of bundles.reverse()) await bundle.detachControllerForRestart().catch(() => {});
    for (const pid of runnerPids) kill(pid);
    for (const entry of await calls().catch(() => [])) if (entry.processStart) kill(entry.processStart);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    const first = createCapabilityRunnerdCodexTransport(options); bundles.push(first);
    let nativeSnapshot: PersistedNativeSession | undefined;
    let thread: { id: string; sessionId: string };
    if (nativeSource) {
      const session = await createNativeSessionBackend(execution, { codexTransportFactory: () => first.transport,
        environment: { PAPERCLIP_WORKSPACE_CWD: root }, dynamicTools: [] }).openSession({ identity: nativeIdentity, workingDirectory: root });
      await session.startTurn({ message: { role: "user", text: "Complete before abrupt loss." } });
      for await (const event of session.events()) if (event.eventType === "turn.completed") break;
      nativeSnapshot = await session.snapshot();
      expect(nativeSnapshot.terminal?.runTerminalState).toBe("succeeded");
      expect(nativeSnapshot.semanticResult?.reportedWorkDisposition).toBe("done");
      thread = { id: nativeSnapshot.sessionId, sessionId: nativeSnapshot.providerSessionId! };
    } else {
      const opened = await first.transport.request("thread/start", { cwd: root, model: "explicit-source-model", dynamicTools: [] });
      thread = { id: (opened.thread as { id: string }).id, sessionId: (opened.thread as { sessionId: string }).sessionId };
      await complete(first);
    }
    await settle();
    expect((await read(coreFile)).committedEvents.some((event: { eventType: string; envelope: { payload: { payload: { runTerminalState?: string } } } }) => event.eventType === "run.terminal" && event.envelope.payload.payload.runTerminalState === "succeeded")).toBe(true);
    const providerIdentity = (await read(providerFile)).identity;
    const pid = first.evidence().runnerPid!;
    await first.detachControllerForRestart(); kill(pid);
    for (const entry of await calls()) if (entry.processStart) kill(entry.processStart);
    await vi.waitFor(async () => { expect(stopped(pid)).toBe(true); for (const entry of await calls()) if (entry.processStart || entry.childPid) expect(stopped(entry.processStart ?? entry.childPid)).toBe(true); });
    const recover = (overrides: Partial<CapabilityRunnerdCodexTransportOptions> = {}) => {
      recovering = true;
      const bundle = createCapabilityRunnerdCodexTransport({ ...options, recoveryLaunch: { requirements: requirements! },
        resumeProviderSession: { driverSessionId: thread.id, providerSessionId: thread.sessionId, providerIdentity }, onRecoveryAccountingEvent: async () => {}, ...overrides, get authorityRunId() { return overrides.authorityRunId ?? "run-target"; } });
      bundles.push(bundle); return bundle;
    };
    return { root, fault, runnerFile, providerFile, coreFile, identity, providerIdentity, thread, calls, count, settle, complete, recover, cleanup, nativeIdentity, nativeSnapshot, execution };
  } catch (error) { await cleanup(); throw error; }
}

it.skipIf(process.platform === "win32")("recovers and adopts ACPX through the real native backend before attachment", async () => {
  const f = await fixture("claude", true);
  try {
    let owner = "run-target";
    let source = f.recover({ get authorityRunId() { return owner; } });
    const backend = () => createNativeSessionBackend(f.execution, { codexTransportFactory: () => source.transport,
      environment: { PAPERCLIP_WORKSPACE_CWD: f.root }, dynamicTools: [] });
    let recovered = await backend().recoverSession!(f.nativeSnapshot!, { signal: new AbortController().signal });
    expect(recovered.recovered).toBe(true);
    const pid = source.evidence().runnerPid, startedAt = source.transport.processInfo!().startedAt;
    expect(await f.count("turn.start")).toBe(1); expect(await f.count("processStart")).toBe(2);
    await recovered.session!.detachControllerForRestart!();
    const launch = vi.fn(() => { throw new Error("duplicate source launch"); });
    source = f.recover({ get authorityRunId() { return owner; }, runnerProcessLauncher: launch, authorizeRunnerAdoption: async () => { throw new Error("old source configuration"); },
      adoptExistingRunner: { pid, processGroupId: pid, startedAt, isAlive: () => !stopped(pid!), signal: () => false } });
    recovered = await backend().recoverSession!(f.nativeSnapshot!, { signal: new AbortController().signal });
    expect(recovered.recovered).toBe(true); expect(launch).not.toHaveBeenCalled(); expect(source.evidence().runnerPid).toBe(pid);
    await expect(source.transport.request("turn/start", {})).rejects.toThrow("source_attachment_pending");
    for (const runId of ["run-target", "run-warm-third"]) {
      owner = runId;
      await recovered.session!.attachRun!({ identity: { ...f.nativeIdentity, runId } });
      expect(source.evidence().runnerPid).toBe(pid);
      await recovered.session!.startTurn({ message: { role: "user", text: "Continue after authenticated attachment." } });
      let completed = false;
      for await (const event of recovered.session!.events()) {
        if (event.eventType === "turn.completed" && event.runId === runId) { completed = true; break; }
      }
      expect(completed).toBe(true); await f.settle();
      const snapshot = await recovered.session!.snapshot();
      expect(snapshot.sessionId).toBe(f.thread.id); expect(snapshot.providerIdentity).toEqual(f.providerIdentity);
      expect(snapshot.semanticResult?.reportedWorkDisposition).toBe("done"); expect(snapshot.terminal).toMatchObject({ runTerminalState: "succeeded" });
    }
    expect(await f.count("turn.start")).toBe(3); expect(await f.count("processStart")).toBe(4);
    expect(await f.count("tool.resolve")).toBe(3);
    await recovered.session!.close({ reason: "test complete" });
  } catch (error) {
    const diagnostics = await readFile(join(f.root, "native.stderr"), "utf8").catch(() => "");
    throw new Error(`${String(error)}\n${diagnostics}`, { cause: error });
  } finally { await f.cleanup(); }
}, 30_000);

it.skipIf(process.platform === "win32").each(["codex", "claude", "adopt", "paused", "retained"] as const)("recovers qualified ACPX %s under source authority before the second turn", async mode => {
  const f = await fixture(mode === "claude" ? "claude" : "codex");
  try {
    await expect(f.recover({ acpxSourceRecoveryVersion: undefined }).transport.request("thread/read", {})).rejects.toThrow("recovery_integrity_unsupported");
    if (mode === "paused") await writeFile(f.fault, "paused");
    if (mode === "retained") {
      const state = await read(f.providerFile);
      for (const [eventType, payload] of [["usage.reported", { cumulative: { inputTokens: 3 } }], ["harness.diagnostic", { code: "retained-source-maintenance", message: "Retained maintenance fact" }]]) {
        state.pendingEvents.push({ executorEventId: `acpx_provider_${String(state.nextEventSequence++).padStart(16, "0")}`, eventType, priority: "p0", payload });
      }
      await writeFile(f.providerFile, JSON.stringify(state));
    }
    const accounting = vi.fn(async (_event: PrpEvent) => {});
    let source = f.recover({ onRecoveryAccountingEvent: accounting });
    expect((await source.transport.request("thread/read", {})).thread).toMatchObject(f.thread); await f.settle();
    await expect(source.transport.request("turn/start", {})).rejects.toThrow("source_attachment_pending");
    const pid = source.evidence().runnerPid;
    if (mode === "adopt") {
      const startedAt = source.transport.processInfo!().startedAt;
      await source.detachControllerForRestart();
      const launch = vi.fn(() => { throw new Error("duplicate source launch"); });
      source = f.recover({ runnerProcessLauncher: launch, authorizeRunnerAdoption: async () => { throw new Error("old source configuration"); },
        adoptExistingRunner: { pid, processGroupId: pid, startedAt, isAlive: () => !stopped(pid!), signal: () => false } });
      expect((await source.transport.request("thread/read", {})).thread).toMatchObject(f.thread);
      expect(source.evidence().runnerPid).toBe(pid); expect(launch).not.toHaveBeenCalled();
    }
    await source.transport.attachRun!({ runId: "run-target", turnId: "turn-target", itemId: "item-target" });
    expect(source.evidence().runnerPid).toBe(pid);
    await f.complete(source); await f.settle();
    expect((await read(f.providerFile)).identity).toEqual(f.providerIdentity);
    expect(await f.count("turn.start")).toBe(2); expect(await f.count("processStart")).toBe(3);
    if (mode === "retained") {
      for (const type of ["usage.reported", "harness.diagnostic"]) {
        const delivered = accounting.mock.calls.filter(call => call[0].eventType === type);
        expect(delivered).toHaveLength(1); expect(delivered[0]![0]).toHaveProperty("runId", f.identity.runId);
      }
    }
    await source.transport.close(); expect((await read(f.runnerFile)).lifecycle).toBe("suspended");
    expect(await f.count("processStart")).toBe(3);
  } catch (error) {
    const diagnostics = (await readFile(join(f.root, "native.stderr"), "utf8").catch(() => ""))
      + (await readFile(join(f.root, "diagnostics", "runnerd.stderr.log"), "utf8").catch(() => ""));
    throw new Error(`${String(error)}\n${diagnostics}`, { cause: error });
  } finally { await f.cleanup(); }
}, 30_000);

it.skipIf(process.platform === "win32").each(["goal", "active", "tool", "goal-during-snapshot"] as const)("stops the owned ACPX process group after live %s admission fails", async fault => {
  const f = await fixture();
  try {
    await writeFile(f.fault, fault);
    await expect(f.recover().transport.request("thread/read", {})).rejects.toThrow("saved dormant ACPX");
    await vi.waitFor(async () => {
      const calls = await f.calls();
      expect(absent(calls.filter(entry => entry.processStart).at(-1)!.processStart)).toBe(true);
      for (const entry of calls) if (entry.processStart || entry.childPid) expect(stopped(entry.processStart ?? entry.childPid)).toBe(true);
    }, { timeout: 5_000 });
    expect(await f.count("processStart")).toBe(2); expect(await f.count("turn.start")).toBe(1);
    if (fault === "goal-during-snapshot") {
      expect((await f.calls()).find(entry => entry.emitted?.eventType === "runtime.goal")?.emitted)
        .toMatchObject({ runId: f.identity.runId, turnId: null, payload: { providerRevision: 2, goal: { status: "active" } } });
    }
  } finally { await f.cleanup(); }
}, 30_000);

it.skipIf(process.platform === "win32").each(["limited", "usage_limited", "budget_limited"] as const)("rejects a saved %s ACPX goal that resumes active and reaps the sidecar", async status => {
  const f = await fixture("claude");
  try {
    const state = await read(f.providerFile);
    state.goalProjection = { schema: "paperclip.session_goal.snapshot.v1", goal: { objective: "Settled limited goal", status, workingNow: false }, workingNow: false };
    await writeFile(f.providerFile, JSON.stringify(state)); await writeFile(f.fault, "goal");
    await expect(f.recover().transport.request("thread/read", {})).rejects.toThrow("saved dormant ACPX resumed an active or unknown goal");
    await vi.waitFor(async () => {
      const calls = await f.calls();
      expect(absent(calls.filter(entry => entry.processStart).at(-1)!.processStart)).toBe(true);
      for (const entry of calls) if (entry.processStart || entry.childPid) expect(stopped(entry.processStart ?? entry.childPid)).toBe(true);
    }, { timeout: 5_000 });
    expect(await f.count("processStart")).toBe(2); expect(await f.count("turn.start")).toBe(1);
  } finally { await f.cleanup(); }
}, 30_000);

it.skipIf(process.platform === "win32")("preserves ordinary same-run active goal restoration", async () => {
  const f = await fixture();
  try {
    const state = await read(f.providerFile);
    state.goalProjection = { schema: "paperclip.session_goal.snapshot.v1", goal: { objective: "Authorized same-run goal", status: "active" }, workingNow: false };
    await writeFile(f.providerFile, JSON.stringify(state)); await writeFile(f.fault, "goal");
    const sameRun = f.recover({ authorityRunId: f.identity.runId });
    expect((await sameRun.transport.request("thread/read", {})).thread).toMatchObject(f.thread);
    expect(await f.count("processStart")).toBe(2); expect(await f.count("turn.start")).toBe(1);
  } finally { await f.cleanup(); }
}, 30_000);

it.skipIf(process.platform === "win32")("settles an ACPX read tail through ordinary transport quiescence before attaching B", async () => {
  const f = await fixture("claude");
  const delivered: PrpEvent[] = [];
  try {
    const source = f.recover({ onRecoveryAccountingEvent: async event => { delivered.push(event); } });
    expect((await source.transport.request("thread/read", {})).thread).toMatchObject(f.thread);
    await f.settle();
    await writeFile(f.fault, "read-diagnostic");
    await source.transport.request("thread/goal/get", {});
    await writeFile(f.fault, "");
    const pid = source.evidence().runnerPid;
    await source.transport.attachRun!({ runId: "run-target", turnId: "turn-target", itemId: "item-target" });
    await f.settle();
    expect(source.evidence().runnerPid).toBe(pid);
    const tail = delivered.filter(event => event.eventType === "harness.diagnostic" && event.payload.code === "ordinary_read_tail");
    expect(tail).toHaveLength(1);
    expect(tail[0]!.runId).toBe(f.identity.runId);
    await f.complete(source); await f.settle();
    expect((await read(f.providerFile)).identity).toEqual(f.providerIdentity);
    expect(await f.count("turn.start")).toBe(2);
    expect(await f.count("processStart")).toBe(3);
  } finally { await f.cleanup(); }
}, 30_000);

// A turn start cut off in flight (here: the sidecar dies mid-start). The
// sidecar's dispatch journal decides what the controller's next turn/start
// may do: resend once when the prompt never left, refuse when it may have.
it.skipIf(process.platform === "win32").each(["before", "after"] as const)("resends an ACPX turn whose start was cut off %s its prompt left, only when the journal proves it", async stage => {
  const f = await fixture("claude");
  try {
    const source = f.recover({ authorityRunId: f.identity.runId });
    expect((await source.transport.request("thread/read", {})).thread).toMatchObject(f.thread);
    await f.settle();
    await writeFile(f.fault, stage === "before" ? "hang-before-dispatch" : "hang-after-dispatch");
    const journal = join(f.root, "acpx", "paperclip-turn-dispatch.jsonl");
    const sidecar = (await f.calls()).filter(entry => entry.processStart).at(-1)!.processStart as number;
    const cut = source.transport.request("turn/start", { input: [{ type: "text", text: "Write the brief." }] })
      .then(() => null, (error: unknown) => error);
    await vi.waitFor(async () => {
      const phases = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line).phase);
      expect(phases).toEqual(stage === "before" ? ["received"] : ["received", "dispatched"]);
    }, { timeout: 10_000 });
    kill(sidecar);
    expect(String(await cut)).toContain(stage === "before" ? "before its prompt reached the provider" : "failed closed");
    await writeFile(f.fault, "");
    const startsBefore = await f.count("turn.start");
    if (stage === "before") {
      await f.complete(source); await f.settle();
      expect(await f.count("turn.start")).toBe(startsBefore + 1);
    } else {
      await expect(source.transport.request("turn/start", { input: [{ type: "text", text: "Write the brief." }] }))
        .rejects.toThrow("ACPX session is not open");
      expect(await f.count("turn.start")).toBe(startsBefore);
    }
  } catch (error) {
    const diagnostics = (await readFile(join(f.root, "native.stderr"), "utf8").catch(() => ""))
      + (await readFile(join(f.root, "diagnostics", "runnerd.stderr.log"), "utf8").catch(() => ""));
    throw new Error(`${String(error)}\n${diagnostics}`, { cause: error });
  } finally { await f.cleanup(); }
}, 60_000);
