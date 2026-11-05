import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { DurablePrpControlPlane } from "../control-plane/durable-prp-control-plane.js";
import { expect, it, vi } from "vitest";
import { createCapabilityRunnerdCodexTransport, type CapabilityRunnerdCodexTransportOptions } from "./runnerd-codex-transport.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, runnerProviderLaunchRequirements, type RunnerProviderLaunchRequirements } from "./runner-provider-launch.js";
import { defaultCapabilityRunnerdBinary, fakeCodex, fakeCodexArgs } from "../../test/support/runnerd-transport.js";
import { createNativeSessionBackend } from "../backends/native-backend-factory.js";
import type { NativeExecutionInput } from "../contracts/native-execution.js";
import type { PersistedNativeSession } from "../contracts/native-session-backend.js";

type Bundle = ReturnType<typeof createCapabilityRunnerdCodexTransport>;
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const absent = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
const kill = (pid: number | null) => { if (pid) { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };

async function sourceFixture(registration?: CapabilityRunnerdCodexTransportOptions["controlPlaneRegistration"], nativeSource = false) {
  const root = await mkdtemp(join(tmpdir(), "runner-source-reconciliation-"));
  const home = join(root, "empty-codex-home"); await mkdir(home);
  const report = join(root, "completion.json");
  if (nativeSource) await writeFile(report, JSON.stringify({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Completed fake work",
    completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] },
    evidence: [], verification: [], attentionRequests: [], artifacts: [] }));
  const identity = { runnerInstanceId: "runner-source", environmentLeaseId: "lease-source", runId: "run-source", normalizedSessionId: "session-source", turnId: "turn-source", itemId: "item-source" };
  const options = {
    runnerBinary: defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
    codexArgs: fakeCodexArgs(root, "--call-log", join(root, "calls"), "--record-process-start", "--durable-turn-ids", ...(nativeSource ? ["--terminal-result-file", report] : [])),
    stateDirectory: root, sourceCodexHome: home, prpIdentity: identity,
    lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 }, runnerProcessReconnectGraceMs: null, runnerReconnectGraceMs: 3_000,
    ...(registration ? { controlPlaneRegistration: registration } : {}),
  };
  const bundles: Bundle[] = [];
  const first = createCapabilityRunnerdCodexTransport(options); bundles.push(first);
  const runnerFile = join(root, "runner", "runner-state.json"), providerFile = join(root, "runner", "codex-provider-state.json"), coreFile = join(root, "control-plane", "control-plane-state.json");
  const calls = async (method: string) => (await readFile(join(root, "calls"), "utf8")).split("\n").filter(line => line === method).length;
  const settled = async (completed = true) => vi.waitFor(async () => {
    const runner = await read(runnerFile), provider = await read(providerFile), core = await read(coreFile);
    expect(runner.outbox).toEqual([]); expect(runner.ackedSourceSeq).toBe(runner.nextSourceSeq - 1);
    expect(provider.pendingEvents).toEqual([]); expect(provider.queuedEvents).toEqual([]);
    expect(provider.activeProviderTurnId).toBeNull(); expect(provider.completedTurnAuthoritative).toBe(completed);
    expect(core.commands.some((command: { status: string }) => command.status === "pending")).toBe(false);
  }, { timeout: 5_000, interval: 25 });
  const complete = async (bundle: Bundle, text: string) => {
    await bundle.transport.request("turn/start", { input: [{ type: "text", text }] });
    for await (const notification of bundle.transport.notifications()) if (notification.method === "turn/completed") return;
    throw new Error("missing terminal turn");
  };
  const dispose = async () => {
    for (const bundle of bundles.reverse()) { await bundle.transport.close().catch(() => undefined); const evidence = bundle.evidence(); kill(evidence.runnerPid); kill(evidence.codexPid); }
    await rm(root, { recursive: true, force: true });
  };
  const nativeIdentity = { companyId: "company", agentId: "agent", issueId: "issue", runId: identity.runId, sessionId: identity.normalizedSessionId };
  const execution: NativeExecutionInput = { schema: "paperclip.native-execution-input.v1",
    binding: { companyId: nativeIdentity.companyId, agentId: nativeIdentity.agentId, issueId: nativeIdentity.issueId,
      runId: identity.runId, executionWorkspaceId: "workspace" },
    task: { identifier: "TASK-1", title: "Complete fake work", description: null, prompt: "Complete fake work", workMode: "standard" },
    workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
    session: { normalizedSessionId: identity.normalizedSessionId, driverKind: "codex_app_server", protocolVersion: 1 },
    provider: { kind: "codex", model: null, approvalPolicy: "never" },
    completionContract: { id: "contract", sha256: `sha256:${"a".repeat(64)}`, schemaVersion: "paperclip.completion-contract.v1",
      contract: { revision: "1", objective: "Complete fake work", criteria: [{ id: "objective", requirement: "Complete fake work" }] } }, interactionResponses: [], credentialBindings: [] };
  try {
    let nativeSnapshot: PersistedNativeSession | undefined;
    let thread: { id: string; sessionId: string };
    if (nativeSource) {
      const session = await createNativeSessionBackend(execution, { codexTransportFactory: () => first.transport,
        environment: { PAPERCLIP_WORKSPACE_CWD: root }, dynamicTools: [] }).openSession({ identity: nativeIdentity, workingDirectory: root });
      await session.startTurn({ message: { role: "user", text: "Complete before abrupt loss." } });
      for await (const event of session.events()) if (event.eventType === "turn.completed") break;
      nativeSnapshot = await session.snapshot();
      expect(nativeSnapshot.terminal?.runTerminalState).toBe("succeeded");
      thread = { id: nativeSnapshot.sessionId, sessionId: nativeSnapshot.providerSessionId! };
    } else {
      const opened = await first.transport.request("thread/start", { cwd: root, dynamicTools: [] });
      const originalThread = opened.thread as { id: string; sessionId: string };
      thread = { id: originalThread.id, sessionId: originalThread.sessionId };
      await complete(first, "Complete before abrupt loss.");
    }
    await settled();
    const evidence = first.evidence();
    await first.detachControllerForRestart();
    expect(absent(evidence.runnerPid!)).toBe(false); expect(absent(evidence.codexPid!)).toBe(false);
    kill(evidence.runnerPid); kill(evidence.codexPid);
    await vi.waitFor(() => { expect(absent(evidence.runnerPid!)).toBe(true); expect(absent(evidence.codexPid!)).toBe(true); });
    expect((await read(runnerFile)).lifecycle).toBe("ready");
    const recover = (overrides: Partial<CapabilityRunnerdCodexTransportOptions> = {}) => {
      const bundle = createCapabilityRunnerdCodexTransport({ ...options, recoveryPurpose: "source_reconcile", resumeProviderSession: { driverSessionId: thread.id, providerSessionId: thread.sessionId }, onRecoveryAccountingEvent: async () => {}, ...overrides });
      bundles.push(bundle); return bundle;
    };
    return { root, options, identity, thread, runnerFile, providerFile, coreFile, calls, complete, settled, recover, dispose, nativeIdentity, execution, nativeSnapshot };
  } catch (error) { await dispose(); throw error; }
}

it("recovers the real native backend before attaching the next run", async () => {
  const f = await sourceFixture(undefined, true);
  try {
    expect(f.nativeSnapshot!.sessionId).toBe(f.thread.id);
    const source = f.recover();
    await expect(source.transport.request("thread/resume", { threadId: f.thread.id })).rejects.toThrow("source_attachment_pending");
    await expect(source.transport.request("thread/read", { threadId: "foreign-thread" })).rejects.toThrow("history_identity_mismatch");
    const recovered = await createNativeSessionBackend(f.execution, { codexTransportFactory: () => source.transport,
      environment: { PAPERCLIP_WORKSPACE_CWD: f.root }, dynamicTools: [] }).recoverSession!(f.nativeSnapshot!, { signal: new AbortController().signal });
    expect(recovered.recovered).toBe(true);
    expect(await f.calls("turn/start")).toBe(1); expect(await f.calls("thread/resume")).toBe(1);
    const before = source.evidence();
    await expect(source.transport.request("thread/resume", { threadId: "foreign-thread" })).rejects.toThrow("history_identity_mismatch");
    await expect(source.transport.request("thread/turns/list", { threadId: "foreign-thread" })).rejects.toThrow("history_identity_mismatch");
    await expect(recovered.session!.startTurn({ message: { role: "user", text: "Not yet authorized" } })).rejects.toThrow();
    expect(await f.calls("turn/start")).toBe(1);
    await recovered.session!.attachRun!({ identity: { ...f.nativeIdentity, runId: "run-target" } });
    expect(source.evidence().runnerPid).toBe(before.runnerPid);
    await recovered.session!.startTurn({ message: { role: "user", text: "Continue under the next run." } });
    let completed = false;
    for await (const event of recovered.session!.events()) {
      if (event.eventType === "turn.completed" && event.runId === "run-target") { completed = true; break; }
    }
    expect(completed).toBe(true);
    await f.settled();
    const snapshot = await recovered.session!.snapshot();
    expect(snapshot.sessionId).toBe(f.thread.id);
    expect(snapshot.terminal).toMatchObject({ runTerminalState: "succeeded" });
    expect(snapshot.semanticResult?.reportedWorkDisposition).toBe("done");
    expect(await f.calls("turn/start")).toBe(2); expect(await f.calls("process-start")).toBe(2);
    expect(await f.calls("thread/resume")).toBe(1);
    await recovered.session!.close({ reason: "test complete" });
  } finally { await f.dispose(); }
}, 30_000);

it.each(["attach", "prepared-attach", "suspend"] as const)("reconciles killed source then uses ordinary %s without a cold receipt", async mode => {
  const fixture = await sourceFixture();
  try {
    if (mode === "prepared-attach") {
      const provider = await read(fixture.providerFile);
      Object.assign(provider, { lifecycle: "prepared", completedTurnAuthoritative: false,
        completedTurnProcessGeneration: null, completedProviderTurnId: null });
      await writeFile(fixture.providerFile, JSON.stringify(provider));
    }
    const resumed = fixture.recover();
    expect((await resumed.transport.request("thread/read", {})).thread).toMatchObject(fixture.thread);
    await fixture.settled(mode !== "prepared-attach");
    for (const method of ["turn/start", "turn/steer", "thread/goal/set", "thread/start"]) {
      await expect(resumed.transport.request(method, {})).rejects.toThrow("source_attachment_pending");
    }
    expect(await fixture.calls("turn/start")).toBe(1);
    const target = { ...fixture.identity, runId: "run-target", turnId: "turn-target", itemId: "item-target" };
    if (mode === "suspend") {
      await resumed.transport.close();
      expect((await read(fixture.runnerFile)).lifecycle).toBe("suspended");
      expect(await fixture.calls("process-start")).toBe(2);
    } else {
      const before = resumed.evidence();
      await resumed.transport.attachRun!(target);
      expect(resumed.evidence()).toMatchObject({ runnerPid: before.runnerPid, codexPid: before.codexPid });
      await fixture.complete(resumed, "Continue under new authority."); await fixture.settled();
      expect((await read(fixture.coreFile)).identity).toEqual(target);
      expect((await read(fixture.providerFile)).threadId).toBe(fixture.thread.id);
      expect(await fixture.calls("turn/start")).toBe(2);
      expect(await fixture.calls("process-start")).toBe(2);
    }
  } finally { await fixture.dispose(); }
}, 30_000);

it.each(["launch", "adopt", "adopt-denied"] as const)("prepares a cacheless source %s without replacing the ordinary source configuration", async mode => {
  let authority: DurablePrpControlPlane | null = null;
  const server = createServer();
  server.on("upgrade", (request, socket, head) => {
    if (authority) authority.handleUpgrade(request, socket, "/runner", head);
    else socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing source listener");
  const registeredIdentities: unknown[] = [];
  const registration: NonNullable<CapabilityRunnerdCodexTransportOptions["controlPlaneRegistration"]> = async (next, identity) => {
    registeredIdentities.push(identity);
    authority = next;
    return { connectUrl: `ws://127.0.0.1:${address.port}/runner`, release: () => { if (authority === next) authority = null; } };
  };
  let cleanup = async () => {};
  try {
    const fixture = await sourceFixture(registration); cleanup = fixture.dispose;
    const before = await read(fixture.coreFile), provider = before.runAttachTemplate.provider;
    before.preparedLaunchConfigurations = [{ identity: fixture.identity, configurationId: "old-source-configuration" }];
    await writeFile(fixture.coreFile, JSON.stringify(before));
    const requirements = runnerProviderLaunchRequirements(fixture.options, fixture.identity, {
      model: provider.model, approvalPolicy: provider.approvalPolicy,
      permissions: provider.readOnly ? "paperclip-runner-workspace-read-only" : "paperclip-runner-workspace-only",
      conversationMode: provider.conversationMode,
      config: { include_collaboration_mode_instructions: provider.includeCollaborationModeInstructions !== false },
    }, null, "You are a Paperclip agent.");
    const prepare = vi.fn(async (input: RunnerProviderLaunchRequirements) => ({ configurationId: input.identity.runId === fixture.identity.runId ? "new-source-incarnation" : "target-configuration", requirementsDigest: runnerLaunchRequirementsDigest(input),
      provider: createRunnerProviderLaunch(input, { options: fixture.options, root: fixture.root, cwd: provider.cwd,
        codexHome: join(fixture.root, "codex-home"), codexCommand: fakeCodex, providerNodeCommand: "", opencodeProxyPath: "", acpxSidecarPath: "" }) }));
    expect((await prepare(requirements)).provider).toEqual(provider); prepare.mockClear();
    const binary = fixture.options.runnerBinary;
    const sourceOptions: Partial<CapabilityRunnerdCodexTransportOptions> = { sourceRecoveryVersion: 1,
      sourceReconciliationLaunch: { requirements }, prepareLaunch: prepare,
      runnerArtifact: { version: "0.3.0", digest: `sha256:${createHash("sha256").update(await readFile(binary)).digest("hex")}` },
      controlPlaneRegistration: registration,
      runnerProcessLauncher: spec => {
        expect(spec.nativeRunner).toHaveProperty("recoveryPurpose", "source_reconcile");
        expect(spec.args).toContain("--source-reconcile");
        const child = spawn(binary, [...spec.args], { env: spec.environment, stdio: "ignore", detached: process.platform !== "win32" });
        return { child, completion: new Promise((resolve, reject) => {
          child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stdout: "", stderr: "" }));
        }) };
      },
    };
    let resumed = fixture.recover(sourceOptions);
    expect((await resumed.transport.request("thread/read", {})).thread).toMatchObject(fixture.thread);
    expect(prepare).toHaveBeenCalledExactlyOnceWith(requirements, undefined);
    expect(registeredIdentities.at(-1)).toEqual(fixture.identity);
    expect((await read(fixture.coreFile)).preparedLaunchConfigurations).toEqual(before.preparedLaunchConfigurations);
    await expect(readFile(join(fixture.root, "launch-preparation.json"))).rejects.toHaveProperty("code", "ENOENT");
    if (mode !== "launch") {
      const evidence = resumed.evidence(), startedAt = resumed.transport.processInfo().startedAt;
      await resumed.detachControllerForRestart();
      prepare.mockClear();
      if (mode === "adopt-denied") prepare.mockRejectedValueOnce(new Error("source preparation authorization revoked"));
      const authorizeOldConfiguration = vi.fn(async () => { throw new Error("old configuration must not authorize source adoption"); });
      const launch = vi.fn(() => { throw new Error("duplicate source process"); });
      const adoption = { pid: evidence.runnerPid, processGroupId: evidence.runnerPid, startedAt,
        isAlive: () => !absent(evidence.runnerPid!), signal: () => false };
      expect(() => fixture.recover({ adoptExistingRunner: adoption })).toThrow("source_reconciliation_requires_retained_source");
      resumed = fixture.recover({ ...sourceOptions, runnerProcessLauncher: launch, authorizeRunnerAdoption: authorizeOldConfiguration,
        adoptExistingRunner: adoption });
      if (mode === "adopt-denied") {
        await expect(resumed.transport.request("thread/read", {})).rejects.toThrow("source preparation authorization revoked");
        expect(absent(evidence.runnerPid!)).toBe(false);
        expect(authorizeOldConfiguration).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
        expect(await fixture.calls("turn/start")).toBe(1); expect(await fixture.calls("process-start")).toBe(2);
        return;
      }
      expect((await resumed.transport.request("thread/read", {})).thread).toMatchObject(fixture.thread);
      expect(resumed.evidence().runnerPid).toBe(evidence.runnerPid);
      expect(registeredIdentities.at(-1)).toEqual(fixture.identity);
      expect(prepare).toHaveBeenCalledExactlyOnceWith(requirements, undefined);
      expect(authorizeOldConfiguration).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
      expect((await read(fixture.coreFile)).preparedLaunchConfigurations).toEqual(before.preparedLaunchConfigurations);
      await expect(readFile(join(fixture.root, "launch-preparation.json"))).rejects.toHaveProperty("code", "ENOENT");
    }
    const target = { ...fixture.identity, runId: "prepared-target", turnId: "prepared-turn", itemId: "prepared-item" };
    await resumed.transport.attachRun!(target);
    expect(prepare.mock.calls.at(-1)?.[0].instructions).toBe(requirements.instructions);
    expect((await read(fixture.coreFile)).preparedLaunchConfigurations).toContainEqual({ identity: target, configurationId: "target-configuration" });
    expect((await read(join(fixture.root, "launch-preparation.json"))).entries).toContainEqual(expect.objectContaining({ prepared: expect.objectContaining({ configurationId: "target-configuration" }) }));
    await fixture.complete(resumed, "Continue after source preparation."); await fixture.settled();
    expect(await fixture.calls("turn/start")).toBe(2); expect(await fixture.calls("process-start")).toBe(2);
    await resumed.transport.close();
    expect((await read(fixture.runnerFile)).lifecycle).toBe("suspended");
    expect(() => fixture.recover({ sourceReconciliationLaunch: { requirements: { ...requirements, identity: { ...fixture.identity, runId: "foreign-source" } } }, prepareLaunch: prepare })).toThrow("source_launch_requirements_invalid");
    expect(() => fixture.recover({ recoveryPurpose: "execution", sourceReconciliationLaunch: { requirements }, prepareLaunch: prepare })).toThrow("source_launch_requirements_invalid");
  } finally { await cleanup(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}, 30_000);

it.each(["active", "ambiguous", "goal", "live-goal"] as const)("rejects unsafe %s source without admitting execution", async state => {
  const fixture = await sourceFixture();
  try {
    const provider = await read(fixture.providerFile);
    const goal = { objective: "Continue independently", status: "active", tokenBudget: null, tokensUsed: 0, elapsedSeconds: 0, iterations: 0, createdAt: null, updatedAt: null, workingNow: false };
    if (state === "live-goal") {
      const file = join(fixture.root, "fake-codex-state.json");
      const actual = await read(file); actual.goal = goal;
      await writeFile(file, JSON.stringify(actual));
    } else if (state === "goal") provider.goal = goal;
    else {
      provider.completedTurnAuthoritative = false; provider.completedTurnProcessGeneration = null; provider.completedProviderTurnId = null;
      if (state === "active") { provider.activeProviderTurnId = "unsettled-turn"; provider.lifecycle = "turn_active"; }
      else provider.ambiguousTurnStartPending = true;
    }
    await writeFile(fixture.providerFile, JSON.stringify(provider));
    const resumed = fixture.recover();
    await expect(resumed.transport.request("thread/read", {})).rejects.toThrow(state === "live-goal" ? "source reconciliation resumed an active or unknown goal" : "source reconciliation requires dormant Codex state");
    expect(await fixture.calls("process-start")).toBe(state === "live-goal" ? 2 : 1);
    expect(await fixture.calls("turn/start")).toBe(1);
  } finally { await fixture.dispose(); }
}, 30_000);

it("retains replayed source tool inputs without dispatching business work or attaching the target", async () => {
  const fixture = await sourceFixture();
  try {
    const provider = await read(fixture.providerFile);
    provider.pendingEvents.push({ executorEventId: `codex_provider_${String(provider.nextProviderEventSeq++).padStart(16, "0")}`, eventType: "semantic_tool.input", priority: "p0", payload: { semantic_tool: {
      schema: "paperclip.prp.semantic_tool.v1", schemaVersion: 1, phase: "input", callId: "retained-source-call", operationId: "get_task_context", input: {}, idempotencyKey: null,
      correlation: { runId: fixture.identity.runId, normalizedSessionId: fixture.identity.normalizedSessionId, turnId: fixture.identity.turnId, itemId: fixture.identity.itemId },
      content: { digest: `sha256:${createHash("sha256").update("{}").digest("hex")}`, redactionDisposition: "digest_only", references: [] },
    } } });
    await writeFile(fixture.providerFile, JSON.stringify(provider));
    const resumed = fixture.recover(), dispatch = vi.fn(async () => ({ success: true, contentItems: [] }));
    resumed.transport.setServerRequestHandler(dispatch);
    await resumed.transport.request("thread/read", {});
    await vi.waitFor(async () => expect((await read(fixture.coreFile)).committedEvents.some((event: { eventType: string }) => event.eventType === "semantic_tool.input")).toBe(true));
    expect(dispatch).not.toHaveBeenCalled();
    await expect(resumed.transport.attachRun!({ runId: "run-target", turnId: "turn-target", itemId: "item-target" })).rejects.toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    expect((await read(fixture.coreFile)).commands.some((command: { type: string }) => command.type === "run.attach")).toBe(false);
    expect(await fixture.calls("turn/start")).toBe(1);
  } finally { await fixture.dispose(); }
}, 30_000);
