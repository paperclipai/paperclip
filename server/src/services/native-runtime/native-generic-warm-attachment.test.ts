import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { completionContracts, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, nativeRunnerCheckpoints } from "@paperclipai/db";
import { expect, it, vi } from "vitest";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { DurablePrpControlPlane, createRunnerdCodexTransport as createCapabilityRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary, readRunnerdArtifactBinding, createRunnerProviderLaunch,
  QUALIFIED_ACPX_PROFILES, type DurableRecoveryIdentity } from "../../vendor/paperclip-runner/index.js";
import { runnerLaunchRequirementsDigest } from "@paperclipai/paperclip-runner";
import { buildNativeExecutionInput } from "./native-execution-input.js";
import { nativeRunnerCheckpointRegistration, loadNativeRunnerCheckpoint, readNativeGenericWarmPublication } from "./native-runner-checkpoint.js";
import { nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { nativeGenericWarmAttachmentPublication, resolveNativeGenericWarmAttachmentRecovery } from "./native-generic-warm-attachment.js";

const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
async function within<T>(phase: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`generic fixture ${phase} did not settle`)), 10_000);
  })]); } finally { clearTimeout(timer); }
}

describeEmbeddedPostgres("generic warm attachment handoff", () => {
  const environment = nativeRestartFixture();

  it.each(["preparing", "transition"] as const)("recovers a new ACPX turn from committed %s with the same remote Runner and no second launch", async (boundary) => {
    const f = await environment.seedRun(`GENERIC-WARM-${boundary}`), shared = environment.current;
    const [contract] = await f.db.select().from(completionContracts).where(eq(completionContracts.issueId, f.issueId));
    const root = join(shared.runtimeRoot, `generic-${boundary}`), remote = join(root, "remote"), oldRoot = join(root, "old"), newRoot = join(root, "new");
    await mkdir(remote, { recursive: true });
    await mkdir(join(remote, "diagnostics"), { recursive: true });
    const journal = join(remote, "calls"), wrapper = join(remote, "sidecar"), script = join(remote, "sidecar-entry");
    const sidecar = resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-acpx-sidecar");
    await writeFile(script, "qualified fixture entry");
    await writeFile(wrapper, `#!/bin/sh\nexec ${quote(sidecar)} --mode source-reconcile --profile-digest ${quote(QUALIFIED_ACPX_PROFILES.claude.commandDigest)} --journal ${quote(journal)} --source-fault ${quote(join(remote, "fault"))}\n`, { mode: 0o700 });
    const binary = defaultCapabilityRunnerdBinary(), artifact = readRunnerdArtifactBinding(binary);
    const sourceId = f.runId, targetId = randomUUID(), sessionId = f.native.normalizedSessionId;
    const sourceIdentity = { runnerInstanceId: f.native.runnerInstanceId, environmentLeaseId: randomUUID(), runId: sourceId,
      normalizedSessionId: sessionId, turnId: `turn-${sourceId}`, itemId: `item-${sourceId}` };
    const targetIdentity = { ...sourceIdentity, runId: targetId, turnId: `turn-${targetId}`, itemId: `item-${targetId}` };
    const bootId = randomUUID();
    const owner = (runId: string) => ({ companyId: shared.companyId, issueId: f.issueId, runId, authorityRunId: runId,
      bootId, generation: 1, leaseOwner: `owner-${runId}` });
    const execution = (runId: string) => buildNativeExecutionInput({ companyId: shared.companyId, agentId: shared.agentId,
      runId, normalizedSessionId: sessionId, provider: "acpx", acpxAgent: "claude", model: "explicit-source-model",
      lifecyclePolicy: { mode: "warm", idleTimeoutMs: 60_000 }, taskPrompt: "Continue normally",
      issue: { id: f.issueId, identifier: "GENERIC-1", title: "Continue", description: null, workMode: "standard" },
      workspace: { id: sourceIdentity.environmentLeaseId, cwd: remote, repoUrl: null, repoRef: null, branchName: null },
      completionContract: { id: contract!.id, sha256: `sha256:${contract!.canonicalSha256}`,
        schemaVersion: contract!.schemaVersion, contract: contract!.contractJson as any }, runtimeContext: nativeRuntimeContextFixture() });
    const sourceExecution = execution(sourceId), currentExecution = execution(targetId);
    await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...f.preparedProfile, nativeExecutionInput: sourceExecution,
      nativePreparationHandoffVersion: 1 },
      createdAt: new Date(Date.now() - 120_000) }).where(eq(heartbeatRuns.id, sourceId));
    await f.db.update(nativeRunFinalizations).set({ controllerBootId: bootId, controllerGeneration: 1,
      leaseOwner: owner(sourceId).leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, sourceId));
    let authority: DurablePrpControlPlane | null = null, authorityRunId = sourceId;
    const register = nativeRunnerCheckpointRegistration({ db: f.db, bootId,
      binding: { companyId: shared.companyId, issueId: f.issueId, runId: sourceId }, authorityRunId: () => authorityRunId });
    let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    let intercepted: DurablePrpControlPlane | null = null, serializedTransitionProven = false;
    const checkpointHooks = new WeakSet<DurablePrpControlPlane>();
    const server = createServer();
    server.on("upgrade", (request, socket, head) => authority ? authority.handleUpgrade(request, socket, "/runner", head) : socket.destroy());
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listener missing");
    const calls = async () => (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const options = { provider: "acpx" as const, acpxAgent: "claude" as const, runnerBinary: binary, runnerArtifact: artifact,
      lifecyclePolicy: { mode: "warm" as const, idleTimeoutMs: 60_000 }, runnerReconnectGraceMs: 3_000,
      get authorityRunId() { return authorityRunId; },
      runnerStateDirectory: join(remote, "runner"),
      readRunnerState: async () => JSON.parse(await readFile(join(remote, "runner", "runner-state.json"), "utf8")),
      controlPlaneCheckpointRegistration: async (core, identity) => {
        if (boundary === "transition" && !checkpointHooks.has(core)) {
          checkpointHooks.add(core);
          const setPersistence = core.setCheckpointPersistence.bind(core);
          vi.spyOn(core, "setCheckpointPersistence").mockImplementation(persist => setPersistence(async checkpoint => {
            if (JSON.parse(checkpoint.records.get("header")!).state.warmTransition?.phase === "prepared") {
              if (intercepted === null) { intercepted = core; entered(); await gate; }
              if (intercepted === core) throw new Error("fixture controller lost before durable transition result");
            }
            await persist(checkpoint);
          }));
        }
        await register(core, identity);
      },
      controlPlaneRegistration: async (core: DurablePrpControlPlane, identity?: DurableRecoveryIdentity) => {
        await register(core, identity);
        if (boundary === "transition" && core.store.state.warmTransition && !serializedTransitionProven) {
          expect(core.store.state.stagedRunAttachment).toBeUndefined();
          const saved = await loadNativeRunnerCheckpoint(f.db, { companyId: shared.companyId, issueId: f.issueId, runId: targetId });
          expect(saved).not.toBeNull();
          const roundTripRoot = join(root, "round-trip");
          saved!.restoreSessionDirectory(roundTripRoot);
          const restored = new DurablePrpControlPlane({ stateDirectory: join(roundTripRoot, "control-plane"),
            identity: core.store.state.identity, expectedRunnerVersion: artifact.version, expectedRunnerDigest: artifact.digest });
          expect(restored.store.state.warmTransition).toEqual(core.store.state.warmTransition);
          expect(restored.store.state.stagedRunAttachment).toBeUndefined();
          await restored.stop();
          serializedTransitionProven = true;
        }
        authority = core;
        return { connectUrl: `ws://127.0.0.1:${address.port}/runner`,
          ...(boundary === "transition" && identity?.runId === targetId ? { connection: { mode: "external" as const } } : {}),
          release: () => { if (authority === core) authority = null; } }; },
      prepareLaunch: async (requirements: Parameters<typeof createRunnerProviderLaunch>[0]) => {
        if (boundary === "preparing" && requirements.identity.runId === targetId) { entered(); await gate; }
        return { configurationId: `configuration-${requirements.identity.runId}`, requirementsDigest: runnerLaunchRequirementsDigest(requirements),
          provider: createRunnerProviderLaunch(requirements, { options: {}, root: remote, cwd: remote, codexHome: remote,
            codexCommand: "", providerNodeCommand: wrapper, opencodeProxyPath: "", acpxSidecarPath: script }) };
      },
    } satisfies NonNullable<Parameters<typeof createCapabilityRunnerdCodexTransport>[0]>;
    const launch = vi.fn((spec: any) => {
      const stderr = openSync(join(remote, "stderr"), "a", 0o600);
      const child = spawn(binary, [...spec.args, "--acpx-launch-authority-digest", sha("fixture authority"),
        "--acpx-sidecar-command", wrapper, "--acpx-sidecar-command-sha256", sha(readFileSync(wrapper)),
        "--acpx-sidecar-script", script, "--acpx-sidecar-script-sha256", sha("qualified fixture entry")],
      { env: { PATH: process.env.PATH, HOME: remote, ...spec.environment }, stdio: ["ignore", "ignore", stderr], detached: true });
      closeSync(stderr);
      return { child, completion: new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
        child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal, stdout: "", stderr: "" })); }) };
    });
    const first = createCapabilityRunnerdCodexTransport({ ...options, stateDirectory: oldRoot, prpIdentity: sourceIdentity, runnerProcessLauncher: launch });
    let successor: ReturnType<typeof createCapabilityRunnerdCodexTransport> | undefined, attachment: Promise<unknown> | undefined;
    try {
      const opened = await within("source thread", first.transport.request("thread/start", { cwd: remote, model: "explicit-source-model", dynamicTools: [] }));
      await first.transport.request("turn/start", { input: [{ type: "text", text: "Complete the source turn." }] });
      await within("source completion", (async () => {
        for await (const event of first.transport.notifications()) if (event.method === "turn/completed") return;
        throw new Error("source completion missing");
      })());
      const pid = first.evidence().runnerPid!, startedAt = first.transport.processInfo!().startedAt;
      await vi.waitFor(async () => expect((await options.readRunnerState()).outbox).toEqual([]));
      const sourceCheckpoint = { sessionId: (opened.thread as any).id, providerSessionId: (opened.thread as any).sessionId,
        providerIdentity: JSON.parse(await readFile(join(remote, "runner", "acpx-provider-state.json"), "utf8")).identity,
        identity: { companyId: shared.companyId, agentId: shared.agentId, issueId: f.issueId, runId: sourceId, sessionId } };
      const [sourceRun] = await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(Date.now() - 1000),
        runnerProfileJson: { nativeExecutionInput: sourceExecution, nativeToolContractFingerprint: nativeToolContractFingerprintForTarget("remote", "acpx"),
          sessionCheckpoint: sourceCheckpoint } }).where(eq(heartbeatRuns.id, sourceId)).returning();
      const resultId = randomUUID();
      await f.db.insert(nativeRunResults).values({ id: resultId, companyId: shared.companyId, issueId: f.issueId, runId: sourceId,
        completionContractId: sourceRun!.completionContractId!, serverFingerprint: "accepted-fixture", schemaStatus: "accepted", resultJson: {}, canonicalSha256: "a".repeat(64) });
      await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, sourceId));
      const rebound = rebindNativeSessionCheckpoint({ previousRun: sourceRun!, currentExecution, executionTargetKind: "remote" });
      expect(rebound).not.toBeNull();
      const [currentRun] = await f.db.insert(heartbeatRuns).values({ id: targetId, companyId: shared.companyId, agentId: shared.agentId,
        nativeIssueId: f.issueId, runtimeMode: "native", status: "running", runnerInstanceId: sourceIdentity.runnerInstanceId,
        nativeSessionId: sessionId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: {},
        completionContractId: sourceRun!.completionContractId, runnerProfileJson: { nativeExecutionInput: currentExecution,
          nativePreparationHandoffVersion: 1, nativePreparationHandoffSourceRunId: sourceId, sessionCheckpoint: rebound } }).returning();
      await f.db.update(issues).set({ executionRunId: targetId }).where(eq(issues.id, f.issueId));
      await f.db.insert(nativeRunFinalizations).values({ runId: targetId, companyId: shared.companyId, issueId: f.issueId,
        phase: "observed", controllerBootId: bootId, controllerGeneration: 1, leaseOwner: owner(targetId).leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) });
      authorityRunId = targetId;
      attachment = first.transport.attachRun!(targetIdentity).catch(error => error);
      await within("attachment preparation", Promise.race([preparing, attachment.then(result => {
        throw result instanceof Error ? result : new Error("attachment ended before external preparation");
      })]));
      const checkpoint = await loadNativeRunnerCheckpoint(f.db, { companyId: shared.companyId, issueId: f.issueId, runId: targetId });
      expect(checkpoint).not.toBeNull();
      const publication = nativeGenericWarmAttachmentPublication(checkpoint!, owner(targetId));
      expect(publication).toMatchObject({ phase: boundary === "transition" ? "queued" : "preparing", sourceIdentity, targetIdentity });
      if (boundary === "transition") expect((await options.readRunnerState()).warmTransition.phase).toBe("prepared");
      const recover = () => resolveNativeGenericWarmAttachmentRecovery({ db: f.db, currentRun: currentRun!, publication: publication!,
        header: checkpoint!.records.get("header")!, owner: owner(targetId) });
      const proof = await recover(); expect(proof).not.toBeNull();
      const binding = { companyId: shared.companyId, issueId: f.issueId, runId: targetId };
      expect(await readNativeGenericWarmPublication(f.db, binding)).not.toBeNull();
      const [cursor] = await f.db.delete(nativeRunnerCheckpoints).where(and(eq(nativeRunnerCheckpoints.companyId, shared.companyId),
        eq(nativeRunnerCheckpoints.runId, targetId), eq(nativeRunnerCheckpoints.part, "cursor"))).returning();
      expect(cursor).toBeDefined();
      expect(await readNativeGenericWarmPublication(f.db, binding)).toBeNull();
      await f.db.insert(nativeRunnerCheckpoints).values(cursor!);
      expect(await readNativeGenericWarmPublication(f.db, binding)).not.toBeNull();
      expect(await resolveNativeGenericWarmAttachmentRecovery({ db: f.db, currentRun: currentRun!, publication: publication!,
        header: checkpoint!.records.get("header")!, owner: { ...owner(targetId), generation: 2 } })).toBeNull();
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...currentRun!.runnerProfileJson,
        nativePreparationHandoffVersion: 0 } }).where(eq(heartbeatRuns.id, targetId));
      expect(await recover()).toBeNull();
      const changed = structuredClone(currentRun!.runnerProfileJson!);
      (changed.nativeExecutionInput as any).provider.model = "different-admitted-model";
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: changed }).where(eq(heartbeatRuns.id, targetId));
      expect(await recover()).toBeNull();
      await f.db.update(heartbeatRuns).set({ runnerProfileJson: currentRun!.runnerProfileJson }).where(eq(heartbeatRuns.id, targetId));
      const detached = first.detachControllerForRestart(); release(); await detached; expect(await attachment).toBeInstanceOf(Error);
      checkpoint!.restoreSessionDirectory(newRoot); await rm(oldRoot, { recursive: true, force: true });
      const noSpawn = vi.fn(() => { throw new Error("duplicate Runner launch"); });
      successor = createCapabilityRunnerdCodexTransport({ ...options, stateDirectory: newRoot, prpIdentity: targetIdentity,
        authorityRunId: targetId,
        authorizeRunnerAdoption: async (configurationId, physicalIdentity) => {
          expect(configurationId).toBe(`configuration-${sourceId}`); expect(physicalIdentity).toEqual(sourceIdentity);
        },
        resumeProviderSession: { driverSessionId: sourceCheckpoint.sessionId, providerSessionId: sourceCheckpoint.providerSessionId,
          providerIdentity: sourceCheckpoint.providerIdentity },
        genericWarmAttachment: { sourceIdentity, targetIdentity, commandSha256: publication!.commandSha256, runnerState: await options.readRunnerState() },
        warmTransitionRegistrationMode: "routed_same_endpoint", runnerProcessLauncher: noSpawn,
        adoptExistingRunner: { pid, processGroupId: pid, startedAt, isAlive: () => { try { process.kill(pid, 0); return true; } catch { return false; } }, signal: () => false } });
      const resumed = await within("successor adoption", successor.transport.request("thread/read", {}));
      if (boundary === "transition") expect(serializedTransitionProven).toBe(true);
      expect(resumed.thread).toMatchObject({ id: (opened.thread as any).id });
      expect(successor.evidence().runnerPid).toBe(pid); expect(noSpawn).not.toHaveBeenCalled(); expect(launch).toHaveBeenCalledTimes(1);
      expect((await options.readRunnerState()).runId).toBe(targetId);
      expect((await calls()).filter(call => call.command === "turn.start")).toHaveLength(1);
      expect((await f.db.select({ phase: nativeRunFinalizations.phase, resultId: nativeRunFinalizations.resultId,
        leaseOwner: nativeRunFinalizations.leaseOwner }).from(nativeRunFinalizations)
        .where(eq(nativeRunFinalizations.runId, sourceId)))[0]).toEqual({ phase: "committed", resultId, leaseOwner: null });
      await f.db.update(nativeRunFinalizations).set({ leaseOwner: "successor" }).where(eq(nativeRunFinalizations.runId, targetId));
      expect(await recover()).toBeNull();
    } catch (error) {
      throw new Error(`${String(error)}\n${(await readFile(join(remote, "stderr"), "utf8").catch(() => "")).slice(-2000)}`, { cause: error });
    } finally {
      release(); await attachment; await successor?.transport.close().catch(() => undefined); await first.transport.close().catch(() => undefined);
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 45_000);
});
