import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, cp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import https, { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { eq } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, it } from "vitest";
import { completionContracts, environmentLeases, environments, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, plugins, agents } from "@paperclipai/db";
import { environmentTaskOperationSchema, type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import { readRunnerdArtifactBinding, defaultCapabilityRunnerdBinary,
  parseNativeExecutionInput, parseNativeRuntimeContext, QUALIFIED_ACPX_PROFILES, type DurableRecoveryIdentity, type RunnerProcessHandle, type RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, canonicalNativeRuntimeContextDigest } from "@paperclipai/paperclip-runner";
import { materializeAsset } from "./runtime-context.js";
import { spawnRunner } from "../../vendor/paperclip-runner/testing.js";
import { describeEmbeddedPostgres, nativeRestartFixture, realProcessIt, fakeCodexAppServer, waitForCondition } from "../../__tests__/helpers/native-restart.js";
import { executePaperclipNativeSession, closeIdleWarmNativeSessionsForRestart, readNativeSessionIdleWork, claimWarmNativeInstructionCopy } from "./native-session-executor.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { environmentService } from "../environments.js";
import { resolveEnvironmentExecutionTarget } from "../environment-execution-target.js";
import { executeEnvironmentTask, isSettledReadyRunnerState } from "../environment-task-runtime.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";

const { createPrivateHostControlFixture } = await import(new URL("../../../../packages/paperclip-runner/test/support/private-host-control.ts", import.meta.url).href) as {
  createPrivateHostControlFixture(): {
    launch(spec: RunnerProcessLaunchSpec): RunnerProcessHandle;
    request(frame: Record<string, unknown>): Promise<{ id: string; status: string }>;
    close(): Promise<void>;
  };
};

const fakeAcpxSidecar = resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-acpx-sidecar");
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const parkId = (source: DurableRecoveryIdentity) => `park_${sha(JSON.stringify(Object.fromEntries(Object.entries(source).sort(([a], [b]) => a.localeCompare(b)))))}`;

// The only replaced service is the external environment-task/Launcher edge.
// Runtime, backend, owner, PRP ingress, checkpoint persistence and native Runner are real.
describeEmbeddedPostgres("plugin Runner eviction through the Core execution entry", () => {
  const environment = nativeRestartFixture();
  const nativeIt = process.platform === "win32" ? it.skip : realProcessIt;
  nativeIt.for([...(["codex", "claude"] as const).flatMap(harness => (["cached", "detached", "reused lease", "prepared copy", "missing stop", "missing state", "foreign state", "working state"] as const).flatMap(mode =>
    // A host can retire the released Runner, or the Runner and its provider can exit abruptly while parked.
    (["retired", "abrupt"] as const).map(exit => [harness, mode, exit] as const)))])("continues %s with a %s Core owner after its Runner exit is %s", { timeout: 60_000 }, async ([harness, mode, exit], context) => {
    if (harness === "claude" && !existsSync(fakeAcpxSidecar)) context.skip();
    const detached = mode === "detached" || mode === "missing state" || mode === "foreign state";
    const denied = mode.startsWith("missing") || mode.endsWith("state");
    const instructionCopy = (id: string) => ({ runId: id, root: workspace, preparationKey: "unchanged-fixture-instructions", hasChanges: async () => false, collectStopped: async () => {} });
    const first = await environment.seedRun(`RELEASE-ENTRY-${harness}-${mode}-${exit}`);
    const { db, runId, issueId, native } = first;
    const { companyId, agentId, runtimeRoot } = environment.current;
    const root = join(runtimeRoot, runId), workspace = join(root, "workspace"), home = join(root, "credential-home");
    await mkdir(workspace, { recursive: true }); await mkdir(home, { recursive: true });
    await writeFile(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-fixture" }), { mode: 0o600 });
    const workspaceId = randomUUID(), environmentId = randomUUID(), leaseA = randomUUID(), taskA = randomUUID(), taskB = randomUUID(), pluginId = randomUUID();
    const providerKey = `plugin:${pluginId}:tasks`;
    const metadata = { driver: "plugin", pluginId, driverKey: "tasks", runnerTaskLease: true };
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "eviction-fixture", version: "1.0.0", status: "ready", manifestJson: { capabilities: ["environment.drivers.register", "agents.lifecycle.manage"], resourceLifecycle: ["agent_runtime"], environmentDrivers: [{ driverKey: "tasks", supportsTasks: true }] } as never });
    await db.update(agents).set({ lifecycleRequiredPluginIds: [pluginId] }).where(eq(agents.id, agentId));
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated", strategyType: "directory", name: "Release fixture", cwd: workspace });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "plugin", config: { pluginKey: pluginId, driverKey: "tasks" } });
    await db.insert(environmentLeases).values({ id: leaseA, companyId, environmentId, heartbeatRunId: runId, issueId,
      executionWorkspaceId: workspaceId, provider: providerKey, providerLeaseId: taskA, status: "active", leasePolicy: "reuse_by_environment", metadata: { ...metadata, remoteCwd: workspace } });
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const runtimeContext = nativeRuntimeContextFixture();
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444, content: Buffer.from("Complete only the controlled task.\n") }]);
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const { permissionPolicy: _permissionPolicy, ...claudeProfile } = QUALIFIED_ACPX_PROFILES.claude;
    const execution = parseNativeExecutionInput({ schema: "paperclip.native-execution-input.v5", executionMode: "default", planningContext: null,
      runtimeContext, binding: { companyId, agentId, issueId, runId, executionWorkspaceId: workspaceId },
      provider: harness === "codex" ? { kind: "codex", model: "fixture-model", approvalPolicy: "never" }
        : { kind: "acpx", agent: "claude", model: "claude-sonnet-4-6", permissionMode: "approve-all", profile: claudeProfile },
      task: { identifier: "RELEASE-ENTRY", title: issue!.title, description: null, prompt: "Complete the controlled task.", workMode: "standard" },
      workspace: { cwd: workspace, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: harness === "codex" ? "codex_app_server" : "acpx_runtime", protocolVersion: 1,
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: detached ? 5_000 : 60_000 } },
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue!, { revision: contract!.revision }) }, interactionResponses: [], credentialBindings: [] });
    const resultFile = join(root, "result.json"), calls = join(root, "provider-calls");
    await writeFile(resultFile, JSON.stringify({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Controlled task complete.",
      completionClaim: { contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
        criteria: execution.completionContract.contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
      evidence: [], verification: [], artifacts: [], attentionRequests: [] }));
    const sidecar = join(root, "sidecar"), sidecarScript = join(root, "sidecar-entry");
    if (harness === "claude") {
      const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;
      await writeFile(sidecarScript, "qualified fixture entry");
      await writeFile(sidecar, `#!/bin/sh\nexec ${quote(fakeAcpxSidecar)} --mode source-reconcile --profile-digest ${quote(claudeProfile.commandDigest)} --journal ${quote(calls)} --source-fault ${quote(join(root, "fault"))} --wait-completion-feedback\n`, { mode: 0o700 });
    }
    const providerPidFile = join(root, "provider.pid"), codexWrapper = join(root, "codex");
    await writeFile(codexWrapper, `#!/bin/sh\necho $$ > '${providerPidFile}'\nexec '${fakeCodexAppServer}' "$@"\n`, { mode: 0o700 });
    const key = join(root, "tls.key"), certificate = join(root, "tls.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
    const oldCAs = getCACertificates("default"), oldAgent = https.globalAgent;
    const certificates = [...oldCAs, await readFile(certificate, "utf8")];
    const probe = createTcpServer(); await new Promise<void>(done => probe.listen(0, "127.0.0.1", done));
    const address = probe.address(); if (!address || typeof address === "string") throw new Error("Fixture listener unavailable");
    const runnerPort = address.port; await new Promise<void>(done => probe.close(() => done()));
    const tls = createServer({ key: await readFile(key), cert: await readFile(certificate) });
    const sockets = new Set<WebSocket>(), websocket = new WebSocketServer({ noServer: true });
    let listenPath = "";
    const wireEvents: string[] = [];
    tls.on("upgrade", (request, socket, head) => {
      if (request.headers["x-fixture-token"] !== "synthetic-ingress") { socket.destroy(); return; }
      websocket.handleUpgrade(request, socket, head, front => {
        const back = new WebSocket(`ws://127.0.0.1:${runnerPort}${listenPath}`, { perMessageDeflate: false });
        const pending: Array<{ data: RawData; binary: boolean }> = []; sockets.add(front); sockets.add(back);
        front.on("message", (data, binary) => {
          if (!binary) { const frame = JSON.parse(data.toString()); wireEvents.push(`core:${frame.kind ?? frame.type}:${frame.payload?.type ?? frame.payload?.eventType ?? frame.error?.code ?? ""}`); }
          if (back.readyState === WebSocket.OPEN) back.send(data, { binary }); else pending.push({ data, binary });
        });
        back.on("open", () => { for (const message of pending.splice(0)) back.send(message.data, { binary: message.binary }); });
        back.on("message", (data, binary) => {
          if (!binary) { const frame = JSON.parse(data.toString()); wireEvents.push(`runner:${frame.kind ?? frame.type}:${frame.payload?.type ?? frame.payload?.eventType ?? frame.error?.code ?? ""}`); }
          if (front.readyState === WebSocket.OPEN) front.send(data, { binary });
        });
        front.on("close", () => { sockets.delete(front); back.terminate(); }); back.on("close", () => { sockets.delete(back); front.terminate(); });
        front.on("error", () => back.terminate()); back.on("error", () => front.terminate());
      });
    });
    await new Promise<void>(done => tls.listen(0, "127.0.0.1", done));
    const tlsAddress = tls.address(); if (!tlsAddress || typeof tlsAddress === "string") throw new Error("Fixture TLS unavailable");
    const hosts = new Map<string, ReturnType<typeof createPrivateHostControlFixture>>([[taskA, createPrivateHostControlFixture()], [taskB, createPrivateHostControlFixture()]]);
    const binary = defaultCapabilityRunnerdBinary();
    const handles = new Map<string, RunnerProcessHandle>();
    const runnerRoot = (taskId: string) => join(root, taskId);
    const artifact = readRunnerdArtifactBinding(binary), preparations = new Map<string, { operation: Extract<PluginEnvironmentTaskOperation, { kind: "prepare" }>; launch: { configurationId: string } }>();
    const releases: DurableRecoveryIdentity[] = [], claims: DurableRecoveryIdentity[] = [];
    let handle: RunnerProcessHandle | undefined, submissions = 0, cleaning = false, sourceReadRequests = 0, sourceReadResponses = 0;
    let pendingFollowup: Promise<unknown> | undefined;
    const providerStarts = async () => (await readFile(calls, "utf8")).trim().split(/\r?\n/)
      .filter(line => harness === "codex" ? line === "process-start" : JSON.parse(line).processStart).length;
    const state = async (taskId: string = taskA) => JSON.parse(await readFile(join(runnerRoot(taskId), "runner-state.json"), "utf8"));
    // Mirrors the Launcher: a stopped Runner's state is restorable once it
    // suspended itself or exited idle at a settled cut.
    const hostRestorable = (live: Record<string, unknown>) => live.lifecycle === "suspended" || isSettledReadyRunnerState(live);
    const sameSource = (a: DurableRecoveryIdentity, b: DurableRecoveryIdentity) => Object.entries(a).every(([key, value]) => b[key as keyof DurableRecoveryIdentity] === value);
    const task = async (raw: unknown, authorityRunId: string, taskId: string): Promise<unknown> => {
      const host = hosts.get(taskId)!;
      const operation = environmentTaskOperationSchema.parse(raw);
      if (operation.kind === "describe") return { kind: "description", taskId, launchPreparationVersion: 1,
        projectAuthCheckVersion: 1, executionContextVersion: 1, warmTaskVersion: 1, releaseResumeVersion: 1, runner: artifact };
      if (operation.kind === "prepare") {
        expect(operation.requirements.identity.runId).toBe(authorityRunId);
        expect(operation.accountIdentity).toBe("fixture-account");
        if (operation.priorIdentity) expect(sameSource(operation.priorIdentity, await state(taskId))).toBe(true);
        expect(operation.requirements.settings.managedProfile).toBeUndefined();
        expect(operation.requirements.settings.agentCoreProfile).toBeUndefined();
        expect(operation.requirements.settings.acpxAgent).toBe(harness === "claude" ? "claude" : undefined);
        const requirements = { ...operation.requirements, runtimeContext: operation.requirements.runtimeContext ? parseNativeRuntimeContext(operation.requirements.runtimeContext) : null, settings: { ...operation.requirements.settings, acpxAgent: harness === "claude" ? "claude" as const : undefined, managedProfile: undefined, agentCoreProfile: undefined } };
        const launch = { configurationId: `configuration-${operation.requirements.identity.runId}`, requirementsDigest: runnerLaunchRequirementsDigest(requirements),
          provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: ["--state-file", join(root, "provider.json"), "--terminal-result-file", resultFile,
            "--call-log", calls, "--record-process-start", "--durable-turn-ids"] }, root, cwd: workspace, codexHome: home, codexCommand: codexWrapper,
            providerNodeCommand: harness === "claude" ? sidecar : process.execPath, opencodeProxyPath: "", acpxSidecarPath: harness === "claude" ? sidecarScript : "" }) };
        preparations.set(launch.configurationId, { operation, launch }); return { kind: "prepared", taskId, launch };
      }
      if (operation.kind === "check_project_auth") return { kind: "project_auth", taskId, configurationId: operation.configurationId, provider: operation.provider, allowed: true };
      if (operation.kind === "submit") {
        if (!operation.preparedLaunchId || !operation.launch) throw new Error("Fixture structured launch unavailable");
        const prepared = preparations.get(operation.preparedLaunchId)!; submissions++;
        if (operation.resumeFrom) {
          expect(operation.resumeFrom).toBe(taskA);
          expect(handles.get(taskA)?.isExitConfirmed?.()).toBe(true);
          await cp(runnerRoot(taskA), runnerRoot(taskId), { recursive: true });
        }
        expect(operation.runner).toMatchObject({ runnerId: prepared.operation.requirements.identity.runnerInstanceId,
          leaseId: prepared.operation.requirements.identity.environmentLeaseId, runId: authorityRunId,
          sessionId: prepared.operation.requirements.identity.normalizedSessionId, turnId: prepared.operation.requirements.identity.turnId,
          itemId: prepared.operation.requirements.identity.itemId });
        listenPath = `/api/runner/v1/connect/${operation.runner.runId}`;
        handle = spawnRunner({ ...operation.launch, stateDirectory: runnerRoot(taskId), identity: prepared.operation.requirements.identity, ticket: operation.bootstrapTicket,
          runnerBinaryPath: binary, maxOutboxBytes: operation.launch.maxOutboxBytes, p0ReserveBytes: operation.launch.p0ReserveBytes,
          connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: runnerPort, listenPath }, processLauncher: host.launch,
          environment: { PATH: process.env.PATH },
          ...(harness === "claude" ? { acpxLaunchProfile: { authorityDigest: `sha256:${sha("fixture authority")}`, command: sidecar,
            commandSha256: `sha256:${sha(await readFile(sidecar, "utf8"))}`, sidecarScript,
            sidecarScriptSha256: `sha256:${sha(await readFile(sidecarScript, "utf8"))}` } } : {}) });
        handles.set(taskId, handle);
        return { kind: "accepted", taskId };
      }
      if (operation.kind === "connection") return { kind: "connection", taskId, endpoint: { kind: "authenticated_websocket",
        websocketUrl: `wss://127.0.0.1:${tlsAddress.port}/runner`, secretHeaders: [{ name: "X-Fixture-Token", value: "synthetic-ingress" }], generation: "fixture" } };
      if (operation.kind === "status") return { kind: "status", taskId, phase: handles.get(taskId)?.isExitConfirmed?.() ? "cancelled" : "running", executionStopped: (cleaning || mode !== "missing stop") && (handles.get(taskId)?.isExitConfirmed?.() ?? false), sessionStateAvailable: (cleaning || mode !== "missing state" && mode !== "missing stop") && handles.get(taskId)?.isExitConfirmed?.() === true && hostRestorable(await state(taskId)) };
      if (operation.kind === "read_state") {
        if (operation.resumeFrom === taskA) sourceReadResponses++;
        const live = await state(operation.resumeFrom ?? taskId);
        const previous = [...preparations.values()].some(({ operation: prepared }) => prepared.priorIdentity && sameSource(prepared.priorIdentity, operation.identity));
        expect(sameSource(operation.identity, live) || previous).toBe(true);
        return { kind: "state", taskId, state: operation.resumeFrom && mode === "foreign state" ? { ...live, turnId: "foreign-turn" }
          : operation.resumeFrom && mode === "working state" ? { ...live, lifecycle: "ready", processedCommands: { ...live.processedCommands,
            "command_unresolved_turn": { commandType: "turn.start", status: "indeterminate" } } } : live };
      }
      if (operation.kind === "archive_state") {
        expect(operation.resumeFrom).toBe(taskA);
        expect(handles.get(taskA)?.isExitConfirmed?.()).toBe(true);
        const path = join(runnerRoot(taskA), "runner-state.json"), archived = join(runnerRoot(taskA), `archive-${operation.archiveKey}.json`);
        try { await rename(path, archived); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const saved = JSON.parse(await readFile(archived, "utf8"));
        expect(sameSource(operation.priorIdentity, saved)).toBe(true);
        return { kind: "state", taskId, state: saved };
      }
      if (operation.kind === "release") {
        const live = await state(taskId); const reply = await host.request({ op: "park", id: parkId(operation.identity), identity: operation.identity,
          lastControllerCommandSeq: live.lastControllerCommandSeq, ackedSourceSeq: live.ackedSourceSeq });
        if (reply.status !== "parked") throw new Error("Fixture native release refused");
        releases.push(operation.identity); return { kind: "released", taskId };
      }
      if (operation.kind === "resume") {
        const retainedProviderCount = await providerStarts();
        const reply = await host.request({ op: "claim", id: `claim_${sha(operation.bootstrapTicket)}`, parkId: parkId(operation.identity), bootstrapTicket: operation.bootstrapTicket });
        if (reply.status !== "claimed") throw new Error("Fixture native claim refused");
        expect(await providerStarts()).toBe(retainedProviderCount);
        claims.push(operation.identity);
        return { kind: "resume", taskId, outcome: "resumed" };
      }
      if (operation.kind === "stop") { await host.close(); }
      if (operation.kind === "complete") { expect(handles.get(taskId)?.isExitConfirmed?.()).toBe(true); }
      return { kind: "accepted", taskId };
    };
    const supervisor = async () => {
      const directory = join(resolvePaperclipInstanceRoot(), "runtime/paperclip-runner/sessions");
      for (const file of await readdir(directory)) {
        const envelope = JSON.parse(await readFile(join(directory, file), "utf8"));
        if (envelope.snapshot?.identity.sessionId === native.normalizedSessionId) return envelope;
      }
      throw new Error("Fixture supervisor record unavailable");
    };
    const proof = async () => (await supervisor()).releasedRunner;
    const workers = { getWorker: () => ({ supportedMethods: ["environmentTask"] }), call: async (_id: string, method: string, params: any, _timeout?: number, _unused?: unknown, settled?: () => void) => {
      if (method === "environmentAcquireLease") return { providerLeaseId: taskB, metadata: { creationOperationId: params.creationOperationId } };
      try { return await task(params.operation, params.runId, params.taskId); } finally { settled?.(); }
    } } as unknown as PluginWorkerManager;
    const dispatch = (leaseId: string, operation: PluginEnvironmentTaskOperation, options?: { executionContext?: unknown; expectedTaskId?: string }) => {
      if (operation.kind === "read_state" && operation.resumeFrom === taskA) sourceReadRequests++;
      return executeEnvironmentTask(db, workers, { companyId, leaseId, operation, ...options });
    };
    const execute = async (current: typeof execution, leaseId: string) => {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: current }, runnerInstanceId: native.runnerInstanceId, completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256, nativeSessionId: current.session.normalizedSessionId })
        .where(eq(heartbeatRuns.id, current.binding.runId));
      const target = mode === "reused lease" ? await resolveEnvironmentExecutionTarget({ db, companyId, adapterType: "paperclip_runner",
        environment: { id: environmentId, driver: "plugin", config: { pluginKey: pluginId, driverKey: "tasks" } }, leaseId,
        lease: await environmentService(db).getLeaseById(leaseId), leaseMetadata: metadata,
        environmentRuntime: environmentRuntimeService(db, { pluginWorkerManager: workers }) }) : {
          kind: "remote" as const, transport: "sandbox" as const, remoteCwd: workspace, environmentId, leaseId, providerKey,
          runnerTask: (operation: unknown, options?: { executionContext?: unknown; expectedTaskId?: string }) => dispatch(leaseId, operation as PluginEnvironmentTaskOperation, options),
          sandboxLeaseAcquisition: { outcome: "created" as const, providerLeaseId: leaseId === leaseA ? taskA : taskB } };
      if (!target) throw new Error("Fixture execution target unavailable");
      return executePaperclipNativeSession({ db, execution: current, runnerInstanceId: native.runnerInstanceId, useRunnerd: true, runnerIngressAuthorized: true,
        runnerEnvironment: harness === "claude" ? { ANTHROPIC_API_KEY: "synthetic-fixture" } : {},
        ...(mode === "prepared copy" ? { instructionWorkingCopy: instructionCopy(current.binding.runId) } : {}),
        managedAiCredentialHome: home, managedAiCredentialIdentity: "fixture-revision", managedAiAccountIdentity: "fixture-account", turnTimeoutMs: 15_000,
        runnerExecutionTarget: target });
    };
    try {
      setDefaultCACertificates(certificates); https.globalAgent = new https.Agent({ ca: certificates });
      const a = await execute(execution, leaseA); expect(a).toMatchObject({ exitCode: 0, timedOut: false });
      await waitForCondition("automatic release A", () => releases.length === 1);
      expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId)))[0]).toMatchObject({ schemaStatus: "accepted", resultJson: { result: { reportedWorkDisposition: "done" } } });
      expect(await proof()).toMatchObject({ source: releases[0], taskId: taskA });
      const providerSessionId = (await supervisor()).snapshot.providerSessionId;
      expect(providerSessionId).toEqual(expect.any(String));
      if (detached) await new Promise(done => setTimeout(done, 5_200));
      expect(readNativeSessionIdleWork()).toBe("none");
      await reconcileNativeFinalizations(db, [runId]);
      const evict = async () => {
        if (exit === "retired") {
          const retired = await hosts.get(taskA)!.request({ op: "retire", id: "host-eviction", parkId: parkId(releases[0]!) });
          expect(retired.status).toBe("retired");
          await handles.get(taskA)!.completion;
          expect((await state()).lifecycle).toBe("suspended");
        } else {
          // Kill the parked Runner and its provider process groups without any suspension.
          const providerPids: number[] = harness === "codex" ? [Number(await readFile(providerPidFile, "utf8"))]
            : (await readFile(calls, "utf8")).trim().split(/\r?\n/).flatMap(line => { const entry = JSON.parse(line); return [entry.processStart, entry.childPid].filter(Number.isInteger); });
          const nativePid = handles.get(taskA)!.child.pid!;
          for (const pid of providerPids) {
            const [parent, group] = execFileSync("ps", ["-p", String(pid), "-o", "ppid=", "-o", "pgid="], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
            expect([nativePid, ...providerPids]).toContain(parent); expect(group).toBe(pid);
          }
          process.kill(nativePid, "SIGKILL");
          for (const pid of providerPids) {
            try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
          }
          await handles.get(taskA)!.completion;
          await waitForCondition("owned providers no longer exist", () => providerPids.every(pid => {
            try { process.kill(pid, 0); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
          }));
          // The journal still holds the settled cut it was parked at.
          expect(isSettledReadyRunnerState(await state())).toBe(true);
        }
        // The existing task runtime records physical stop and state availability.
        expect(await dispatch(leaseA, { kind: "status" })).toMatchObject({ executionStopped: mode !== "missing stop", sessionStateAvailable: mode !== "missing state" && mode !== "missing stop" });
        if (mode !== "missing stop") {
          await dispatch(leaseA, { kind: "complete" });
          await db.update(environmentLeases).set({ status: "released", releasedAt: new Date(), cleanupStatus: "success" }).where(eq(environmentLeases.id, leaseA));
        }
      };
      if (mode !== "reused lease") await evict();
      const admitNext = async () => {
        const runB = randomUUID(), leaseB = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runB, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native" });
        await db.insert(nativeRunFinalizations).values({ runId: runB, companyId, issueId, phase: "observed" });
        await db.update(issues).set({ executionRunId: runB, status: "in_progress" }).where(eq(issues.id, issueId));
        const [oldLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseA));
        await db.insert(environmentLeases).values({ id: leaseB, companyId, environmentId, heartbeatRunId: runB, issueId, executionWorkspaceId: workspaceId,
          provider: providerKey, providerLeaseId: mode === "reused lease" ? taskA : taskB, status: "active", leasePolicy: "reuse_by_environment",
          metadata: mode === "reused lease" ? { ...oldLease!.metadata, runnerTaskReused: true, runnerTaskPreviousLeaseId: leaseA,
            runnerTaskExecutionStopped: false } : { ...metadata, remoteCwd: workspace } });
        if (mode === "reused lease") {
          expect(handles.get(taskA)!.isExitConfirmed?.()).toBe(false);
          await evict(); // B already holds A when the host evicts it, before normal describe/claim.
        }
        const next = { ...execution, binding: { ...execution.binding, runId: runB } };
        const releasePreparation = mode === "prepared copy" ? await claimWarmNativeInstructionCopy({ priorExecution: execution,
          companyId, agentId, executionWorkspaceId: workspaceId, workspace: execution.workspace, environmentId, runId: runB,
          preparationKey: "unchanged-fixture-instructions", adopt: async () => instructionCopy(runB) }) : null;
        if (mode === "prepared copy") expect(releasePreparation).toBeTypeOf("function");
        pendingFollowup = execute(next, leaseB);
        if (denied) {
          const refusal = mode === "working state" ? "checkpoint_not_settled"
            : mode === "foreign state" ? "Plugin Runner checkpoint identity mismatch"
            : "Plugin Runner retained session is not authorized";
          await expect(pendingFollowup).rejects.toThrow(refusal);
          if (mode === "missing stop") expect(sourceReadRequests).toBe(0);
          else expect(sourceReadRequests).toBeGreaterThan(0);
          if (mode === "foreign state" || mode === "working state") expect(sourceReadResponses).toBeGreaterThan(0);
          else expect(sourceReadResponses).toBe(0);
          expect(submissions).toBe(1); expect(claims).toEqual([]);
          expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runB))).toHaveLength(0);
          expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId))).toHaveLength(1);
          return runB;
        }
        expect(await pendingFollowup).toMatchObject({ exitCode: 0, timedOut: false });
        expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runB)))[0]).toMatchObject({ schemaStatus: "accepted", resultJson: { result: { reportedWorkDisposition: "done" } } });
        await reconcileNativeFinalizations(db, [runB]);
        await releasePreparation?.();
        return runB;
      };
      const runB = await admitNext();
      if (denied) return;
      await waitForCondition("automatic release B", () => releases.length === 2);
      expect(await proof()).toMatchObject({ source: releases[1], taskId: taskB });
      expect((await supervisor()).snapshot.providerSessionId).toBe(providerSessionId);
      const methods = (await readFile(calls, "utf8")).trim().split(/\r?\n/);
      expect(submissions).toBe(2);
      expect(releases[1]!.runId).toBe(runB);
      expect(claims).toEqual([]);
      if (harness === "codex") {
        expect(methods.filter(method => method === "process-start")).toHaveLength(2);
        expect(methods.filter(method => method === "turn/start")).toHaveLength(2);
      } else {
        const journal = methods.map(line => JSON.parse(line));
        expect(journal.filter(entry => entry.command === "turn.start")).toHaveLength(2);
      }
      expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId)))).toHaveLength(1);
    } catch (error) {
      const live = await state().catch(() => ({}));
      console.info("entry-fixture", { releases: releases.length, claims: claims.length, lifecycle: live.lifecycle,
        lastCommand: live.lastControllerCommandSeq, ackedSource: live.ackedSourceSeq, outbox: live.outbox?.map((e: { envelope?: { payload?: { eventType?: string } } }) => e.envelope?.payload?.eventType), wire: wireEvents.slice(-70) });
      throw error;
    } finally {
      cleaning = true;
      await pendingFollowup?.catch(() => undefined);
      try {
        const cleanup = await Promise.allSettled([closeIdleWarmNativeSessionsForRestart(), ...[...hosts.values()].map(host => host.close())]);
        for (const socket of sockets) socket.terminate(); websocket.close();
        await new Promise<void>(done => tls.close(() => done()));
        const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Fixture cleanup failed");
      } finally {
        https.globalAgent.destroy(); https.globalAgent = oldAgent; setDefaultCACertificates(oldCAs);
      }
    }
  });
});
