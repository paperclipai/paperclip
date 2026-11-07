import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, expect, it, vi } from "vitest";
import { completionContracts, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { describeEmbeddedPostgres, nativeRestartFixture } from "../../__tests__/helpers/native-restart.js";
import { DurablePrpControlPlane, parseNativeExecutionInput, QUALIFIED_ACPX_PROFILES, QUALIFIED_ACPX_VERSION, type NativeSessionBackend, type PersistedNativeSession } from "../../vendor/paperclip-runner/index.js";
import { createNativeControllerRecovery } from "./native-controller-recovery.js";
import { nativeRunnerCheckpointWriter } from "./native-runner-checkpoint.js";
import { createRunnerdBackend, executePaperclipNativeSession, nativeControllerMigrationDescriptor, scopedRunnerdStateRoot } from "./native-session-executor.js";
import { nativeToolContractFingerprintForTarget, rebindNativeSessionCheckpoint } from "./native-session-resume.js";
import { prepareNativeHeartbeatRun } from "./prepare-native-run.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { nativeSha256 } from "./canonical.js";

const remoteBoundary = vi.hoisted(() => ({
  backend: vi.fn((_execution: unknown, _options: { codexTransportFactory?: (context: unknown) => unknown }) => ({})),
  transport: vi.fn((_options: Record<string, unknown>) => ({ transport: {} })),
  packPath: "", binaryPath: "",
}));
vi.mock("../../vendor/paperclip-runner/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../vendor/paperclip-runner/index.js")>(),
  createNativeSessionBackend: remoteBoundary.backend,
  createRunnerdCodexTransport: remoteBoundary.transport,
  bundledRemoteProviderPackManifestPath: () => remoteBoundary.packPath,
  bundledRemoteRunnerBinary: () => remoteBoundary.binaryPath,
}));
vi.mock("./paperclip-runner-tool-authority.js", () => ({ PaperclipRunnerToolAuthority: class {
  readonly binding = {};
  async definitions() { return []; }
  close() {}
} }));

describeEmbeddedPostgres("legacy harness continuation without provider-home files", () => {
  const environment = nativeRestartFixture();
  const homes: string[] = [];
  afterEach(async () => { vi.unstubAllEnvs(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });

  it.each([["codex", "per_turn"], ["opencode", "per_turn"], ["codex", "warm"]] as const)("preserves explicit %s %s recovery policy through server and Runner on both homes", async (provider, lifecycle) => {
    for (const policy of ["allow_replacement_after_resume_failure", "allow_replacement_after_governed_wait"] as const) {
      const observations = [];
      for (const pose of ["original", "empty"] as const) {
        vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "61".repeat(32));
        const f = await environment.seedRun(randomUUID());
        const { companyId, agentId, runtimeRoot } = environment.current;
        const home = await mkdtemp(join(tmpdir(), "native-harness-independence-")); homes.push(home);
        vi.stubEnv("PAPERCLIP_HOME", home);
        const workspaceId = randomUUID();
        const [sourceRun] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
        const [contract] = await f.db.select().from(completionContracts).where(eq(completionContracts.id, sourceRun!.completionContractId!));
        const execution = parseNativeExecutionInput({
          schema: "paperclip.native-execution-input.v5", executionMode: "default", planningContext: null,
          provider: provider === "codex" ? { kind: "codex", model: null, approvalPolicy: "never" } : { kind: "opencode", model: "fixture/model", permissionMode: "allow" },
          binding: { companyId, agentId, issueId: f.issueId, runId: f.runId, executionWorkspaceId: workspaceId },
          task: { identifier: "LHI-1", title: "Retained provider work", description: null, prompt: "Continue the saved work.", workMode: "standard" },
          workspace: { cwd: runtimeRoot, repoUrl: null, repoRef: null, branchName: null },
          session: { normalizedSessionId: f.native.normalizedSessionId, driverKind: provider === "codex" ? "codex_app_server" : "opencode_server", protocolVersion: 1, lifecyclePolicy: lifecycle === "per_turn" ? { mode: "per_turn", idleTimeoutMs: null } : { mode: "warm", idleTimeoutMs: 60_000 } },
          completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: contract!.schemaVersion, contract: contract!.contractJson },
          runtimeContext: nativeRuntimeContextFixture(), credentialBindings: [], interactionResponses: [],
        });
        const semanticResult = { schema: "paperclip.run_result.v1", reportedWorkDisposition: policy === "allow_replacement_after_governed_wait" ? "yielded" : "done", summary: "Prior provider result", completionClaim: { contractRevision: "1", objectiveSatisfied: policy !== "allow_replacement_after_governed_wait", criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [] }], remainingWork: [] }, evidence: [], verification: [], attentionRequests: [], artifacts: [], ...(policy === "allow_replacement_after_governed_wait" ? { continuation: { kind: "response_wake", summary: "Continue after the answer", idempotencyKey: "fixture-answer" } } : {}) };
        const snapshot: PersistedNativeSession = { backendKind: "runner", driverKind: execution.session.driverKind, sessionId: "retained-driver-session", providerSessionId: "retained-provider-session", identity: { companyId, agentId, issueId: f.issueId, runId: f.runId, sessionId: f.native.normalizedSessionId }, cursor: "0", activeTurnId: null, pendingRuntimeRequests: [], terminalTurns: [], lineage: [], semanticResult: semanticResult as never, goal: null };
        const fingerprint = nativeToolContractFingerprintForTarget("remote", provider);
        const descriptor = nativeControllerMigrationDescriptor(execution, fingerprint);
        const bootId = randomUUID(), leaseOwner = randomUUID();
        await f.db.update(nativeRunFinalizations).set({ controllerBootId: bootId, controllerGeneration: 1, controllerPid: 2_147_483_000, controllerProcessStartedAt: new Date(Date.now() - 60_000), leaseOwner, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(nativeRunFinalizations.runId, f.runId));
        const core = new DurablePrpControlPlane({ stateDirectory: join(runtimeRoot, randomUUID()), identity: { runId: f.runId, normalizedSessionId: f.native.normalizedSessionId, runnerInstanceId: f.native.runnerInstanceId, environmentLeaseId: f.native.environmentLeaseId, turnId: f.native.turnId, itemId: f.native.itemId }, expectedRunnerVersion: "independence-fixture", expectedRunnerDigest: `sha256:${"a".repeat(64)}` });
        for (const type of ["run.prepare", "session.open", "turn.start", "runner.suspend"]) Object.assign(core.queueCommand(type), { status: "completed", result: { status: "completed" } });
        core.store.state.committedEvents.push({ sourceSeq: 1, sourceEventId: "fixture-terminal", eventType: "run.terminal", priority: 0, envelope: { ...core.store.state.identity }, deliveryCount: 1, logicalEffectCount: 1 });
        core.store.state.ackedSourceSeq = 1;
        core.setCheckpointPersistence(nativeRunnerCheckpointWriter(f.db, { companyId, issueId: f.issueId, runId: f.runId, authorityRunId: f.runId, bootId, generation: 1, leaseOwner }));
        await core.flushCheckpoint(); await core.stop();
        const [result] = await f.db.insert(nativeRunResults).values({ companyId, issueId: f.issueId, runId: f.runId, completionContractId: (await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!.completionContractId!, serverFingerprint: randomUUID(), schemaStatus: "accepted", resultJson: semanticResult, canonicalSha256: "a".repeat(64) }).returning();
        const sourceProfile = { ...f.preparedProfile, nativeExecutionInput: execution, nativeToolContractFingerprint: fingerprint, sessionCheckpoint: snapshot, nativeControllerRecovery: createNativeControllerRecovery(snapshot, { configDigest: descriptor.configDigest, processConfigDigest: null }, { runId: f.runId, runnerInstanceId: f.native.runnerInstanceId, normalizedSessionId: f.native.normalizedSessionId }) };
        await f.db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), runnerProfileJson: sourceProfile }).where(eq(heartbeatRuns.id, f.runId));
        await f.db.update(nativeRunFinalizations).set({ phase: "committed", resultId: result!.id, leaseOwner: null, leaseExpiresAt: null }).where(eq(nativeRunFinalizations.runId, f.runId));
        if (pose === "original") { await mkdir(join(scopedRunnerdStateRoot(execution), "codex-home", "skills"), { recursive: true, mode: 0o700 }); await writeFile(join(home, "retained-unrelated-file"), "preserve"); }
        const runId = randomUUID();
        const [run] = await f.db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: f.issueId, issueId: f.issueId, status: "running", runtimeMode: "native", nativeSessionId: f.native.normalizedSessionId, runnerInstanceId: f.native.runnerInstanceId, completionContractId: sourceRun!.completionContractId, completionContractSha256: sourceRun!.completionContractSha256 }).returning();
        const native = await prepareNativeHeartbeatRun({ db: f.db, run: run!, issue: { id: f.issueId, title: "Retained provider work", description: null }, environmentLeaseId: randomUUID() });
        const current = { ...execution, binding: { ...execution.binding, runId } };
        const rebound = rebindNativeSessionCheckpoint({ previousRun: { id: f.runId, companyId, agentId, nativeSessionId: f.native.normalizedSessionId, runnerProfileJson: sourceProfile }, currentExecution: current, executionTargetKind: "remote" });
        expect(rebound?.providerRecoveryPolicy).toBe(policy);
        const [prepared] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
        await f.db.update(heartbeatRuns).set({ runnerProfileJson: { ...prepared!.runnerProfileJson, nativeExecutionInput: current, sessionCheckpoint: rebound } }).where(eq(heartbeatRuns.id, runId));
        await f.db.insert(nativeRunFinalizations).values({ runId, companyId, issueId: f.issueId, phase: "observed" });
        await f.db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
        const recover = vi.fn(async (saved: PersistedNativeSession) => ({ recovered: false as const, reason: "fixture provider source is absent" }));
        const fresh = vi.fn(async () => { throw new Error("fixture replacement observed before provider turn"); });
        const describe = vi.fn<NativeSessionBackend["descriptor"]>(async () => ({ kind: "runner", name: "controlled provider boundary", version: "fixture", capabilities: { resume: true, typedEvents: true, steering: false, interruption: true, structuredResult: true }, runtimeContextCapabilities: { instructions: "native", skills: "native", mcp: "native" } }));
        const backend: NativeSessionBackend = { descriptor: describe, recoverSession: recover, openSession: fresh, openReplacementSession: fresh };
        const failure = await executePaperclipNativeSession({ db: f.db, execution: current, runnerInstanceId: native.runnerInstanceId, useRunnerd: true, backend, runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: runtimeRoot, environmentId: randomUUID(), leaseId: randomUUID(), providerKey: "fixture", reusableLeaseConfigured: true, runner: { execute: async () => { throw new Error("unexpected remote process execution"); } }, sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "new-fixture-sandbox" } } as never }).catch(error => error);
        if (lifecycle === "warm") {
          expect(String(failure)).toContain("runner_state_identity_mismatch: prior_owner_terminal_state_indeterminate");
          expect(describe).not.toHaveBeenCalled(); expect(recover).not.toHaveBeenCalled(); expect(fresh).not.toHaveBeenCalled();
          const [retained] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
          const [unchanged] = await f.db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
          expect(retained!.runnerProfileJson).toEqual(sourceProfile);
          expect(unchanged!.runnerProfileJson?.sessionCheckpoint).toEqual(rebound);
          observations.push({ refusal: String(failure), providerSessionId: rebound!.providerSessionId,
            policy: rebound!.providerRecoveryPolicy, replacementAttempts: 0 });
          continue;
        }
        expect(recover, String(failure)).toHaveBeenCalledOnce();
        expect(recover.mock.calls[0]![0]).toMatchObject({ providerSessionId: snapshot.providerSessionId, providerRecoveryPolicy: policy, identity: { runId } });
        expect(fresh).toHaveBeenCalledTimes(policy === "allow_replacement_after_resume_failure" ? 1 : 0);
        const digest = `sha256:${"a".repeat(64)}`;
        const artifacts = Object.fromEntries(Object.entries({ grokLauncher: "dist/providers/grok/launcher.cjs", nodeCommand: "node_modules/node/bin/node",
          productionLock: "pnpm-lock.yaml", opencodeCommand: "node_modules/.bin/opencode", opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
          opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs" }).map(([key, path]) => [key, { path, sha256: digest }]));
        const payload = { compatibility: { opencode: 1, acpx: 1 }, contractDigest: digest, target: { platform: "linux", architecture: "x64" },
          runnerSourceRevision: "a".repeat(40), pins: { nodeMinimum: "24.11.0", codex: QUALIFIED_ACPX_PROFILES.codex.agentRuntimeVersion,
            opencode: "1.18.34", acpx: QUALIFIED_ACPX_VERSION, grok: QUALIFIED_ACPX_PROFILES.grok.agentRuntimeVersion,
            claudeAcp: QUALIFIED_ACPX_PROFILES.claude.agentServerVersion, codexAcp: QUALIFIED_ACPX_PROFILES.codex.agentServerVersion },
          acpxProfileDigests: Object.fromEntries(["grok", "claude", "codex"].map(agent => [agent, QUALIFIED_ACPX_PROFILES[agent as "grok" | "claude" | "codex"].commandDigest])),
          distDigest: digest, artifacts, bridgeDigest: `sha256:${createHash("sha256").update(`${digest}\n${digest}\n${digest}`).digest("hex")}` };
        const pack = { schema: "paperclip-runner/remote-provider-pack/v1", payload, digest: `sha256:${nativeSha256(payload)}` };
        remoteBoundary.packPath = join(home, "provider-pack.json"); remoteBoundary.binaryPath = join(home, "fixture-runnerd");
        const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf.writeUInt16LE(62, 18);
        await writeFile(remoteBoundary.packPath, JSON.stringify(pack)); await writeFile(remoteBoundary.binaryPath, elf);
        const remoteExecute = vi.fn(async (command: { args?: string[] }) => ({ exitCode: command.args?.[1]?.includes("base64") ? 1 : 0,
          timedOut: false, stderr: "", stdout: command.args?.[0] === "--build-metadata" ? JSON.stringify({
            schema: "paperclip-runner/runnerd-build-metadata/v1", binaryName: "paperclip-runnerd", packageName: "@paperclipai/paperclip-runner",
            binaryContractVersion: 2, durableSessionCapabilities: ["unlimited_runtime", "connection_lease_renewal"], prpTransportModes: ["listen_ws"],
            providerPacks: [{ root: "/opt/paperclip-runner/provider-pack", manifest: pack, immutable: true }],
          }) : command.args?.[0] === "--version" ? "codex-cli 0.160.0" : command.args?.[1] === "uname -s; uname -m" ? "Linux\nx86_64\n" : "" }));
        await createRunnerdBackend({ db: f.db, execution: current, runnerInstanceId: native.runnerInstanceId, runnerIngressAuthorized: true, runnerRemoteBinaryPath: remoteBoundary.binaryPath,
          runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: "/workspace", environmentId: randomUUID(), leaseId: randomUUID(),
            providerKey: "fixture", reusableLeaseConfigured: true, effectiveCapabilities: { runnerWebSocketIngress: true },
            runner: { execute: remoteExecute, syncIn: vi.fn(async () => undefined) },
            sandboxLeaseAcquisition: { outcome: "created", providerLeaseId: "new-fixture-sandbox" } } as never });
        remoteBoundary.backend.mock.calls.at(-1)![1].codexTransportFactory!({
          persistedSession: { driverSessionId: snapshot.sessionId, providerSessionId: snapshot.providerSessionId }, providerRecoveryPolicy: policy });
        const transport = remoteBoundary.transport.mock.calls.at(-1)![0];
        await expect((transport.prepareExternalRunnerState as () => Promise<void>)()).resolves.toBeUndefined();
        expect(transport.providerRecoveryPolicy).toBe(policy);
        expect(transport.resumeProviderSession).toMatchObject({ providerSessionId: snapshot.providerSessionId });
        observations.push({ providerSessionId: recover.mock.calls[0]![0].providerSessionId, policy: recover.mock.calls[0]![0].providerRecoveryPolicy, replacementAttempts: fresh.mock.calls.length });
      }
      expect(observations[0]).toEqual(observations[1]);
    }
  }, 60_000);
});
