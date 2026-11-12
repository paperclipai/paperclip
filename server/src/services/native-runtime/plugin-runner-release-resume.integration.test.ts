import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import https, { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { and, eq } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { expect, it, vi } from "vitest";
import { completionContracts, environmentLeases, environments, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import { environmentTaskOperationSchema, type PluginEnvironmentTaskOperation } from "@paperclipai/plugin-sdk";
import { readRunnerdArtifactBinding, defaultCapabilityRunnerdBinary,
  parseNativeExecutionInput, parseNativeRuntimeContext, QUALIFIED_ACPX_PROFILES, type DurableRecoveryIdentity, type RunnerProcessHandle, type RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, canonicalNativeRuntimeContextDigest } from "@paperclipai/paperclip-runner";
import { materializeAsset } from "./runtime-context.js";
import { spawnRunner } from "../../vendor/paperclip-runner/testing.js";
import { describeEmbeddedPostgres, nativeRestartFixture, realProcessIt, fakeCodexAppServer, waitForCondition } from "../../__tests__/helpers/native-restart.js";
import { executePaperclipNativeSession, cancelNativeSession, closeIdleWarmNativeSessionsForRestart, readNativeSessionIdleWork } from "./native-session-executor.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import * as remoteWarmRecovery from "./remote-warm-session-recovery.js";
import { reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { PROCESS_START_REQUESTED } from "../native-local-process-stop.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

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
describeEmbeddedPostgres("plugin Runner release/resume through the Core execution entry", () => {
  const environment = nativeRestartFixture();
  const nativeIt = process.platform === "win32" ? it.skip : realProcessIt;
  nativeIt.for([...(["codex", "claude"] as const).flatMap(harness => (["cached", "adopted", "adopted restart"] as const).map(mode => [harness, mode] as const)), ["codex", "adopted cancellation"] as const, ["codex", "adopted legacy cancellation"] as const,
    ["codex", "cached cancellation"] as const, ["codex", "cached held claim"] as const, ["claude", "cached held claim"] as const,
    ["codex", "cached managed GitHub"] as const, ["codex", "adopted managed GitHub"] as const, ["codex", "adopted restart managed GitHub"] as const])("completes %s runs through a retained %s process", { timeout: 60_000 }, async ([harness, mode], context) => {
    if (harness === "claude" && !existsSync(fakeAcpxSidecar)) context.skip();
    const adopted = mode.startsWith("adopted"), cancellation = mode.includes("cancellation"), heldClaimMode = mode === "cached held claim";
    const restart = mode.includes("restart");
    const qualifiedCancellation = mode === "adopted cancellation" || mode === "cached cancellation";
    const managedGitHub = mode.endsWith("managed GitHub"), brokerUrl = "https://core.example.test/api", brokerToken = (runId: string) => `fixture-broker-${runId}`;
    const preparedBrokers: Array<{ runId: string; token?: string }> = [];
    const first = await environment.seedRun(`RELEASE-ENTRY-${harness}-${mode}`);
    const { db, runId, issueId, native } = first;
    const { companyId, agentId, runtimeRoot } = environment.current;
    const root = join(runtimeRoot, runId), workspace = join(root, "workspace"), home = join(root, "credential-home");
    await mkdir(workspace, { recursive: true }); await mkdir(home, { recursive: true });
    await writeFile(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "synthetic-fixture" }), { mode: 0o600 });
    const workspaceId = randomUUID(), environmentId = randomUUID(), leaseA = randomUUID(), taskId = randomUUID();
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, sourceIssueId: issueId,
      mode: "isolated", strategyType: "directory", name: "Release fixture", cwd: workspace });
    await db.insert(environments).values({ id: environmentId, name: environmentId, driver: "plugin" });
    await db.insert(environmentLeases).values({ id: leaseA, companyId, environmentId, heartbeatRunId: runId, issueId,
      executionWorkspaceId: workspaceId, provider: "plugin:fixture:tasks", providerLeaseId: taskId, status: "active", leasePolicy: "reuse_by_environment", metadata: { remoteCwd: workspace } });
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
        lifecyclePolicy: { mode: "warm", idleTimeoutMs: adopted && !restart ? 5_000 : 60_000 } },
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
    const host = createPrivateHostControlFixture(), runnerRoot = join(root, "native"), binary = defaultCapabilityRunnerdBinary();
    const artifact = readRunnerdArtifactBinding(binary), preparations = new Map<string, { operation: Extract<PluginEnvironmentTaskOperation, { kind: "prepare" }>; launch: { configurationId: string } }>();
    const releases: DurableRecoveryIdentity[] = [], claims: DurableRecoveryIdentity[] = [];
    const operationsDuringClaim: string[] = [];
    let claimHeld = false, holdPreparationFor: string | undefined, claimedDuringPreparation = false;
    const toolDefinitions = PaperclipRunnerToolAuthority.prototype.definitions;
    const preparation = vi.spyOn(PaperclipRunnerToolAuthority.prototype, "definitions").mockImplementation(function (this: PaperclipRunnerToolAuthority) {
      const definitions = toolDefinitions.call(this);
      if (holdPreparationFor === undefined || this.binding.runId !== holdPreparationFor) return definitions;
      holdPreparationFor = undefined;
      return waitForCondition("claim during preparation", () => claims.length === 1)
        .then(() => { claimedDuringPreparation = true; return definitions; }) as unknown as typeof definitions;
    });
    const processStartRequested = async (id: string) => (await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.runId, id), eq(heartbeatRunEvents.eventType, PROCESS_START_REQUESTED)))).length > 0;
    let handle: RunnerProcessHandle | undefined, submissions = 0, stops = 0, completes = 0;
    let releaseClaimReply!: () => void, observeHeldClaim!: () => void;
    const claimReply = new Promise<void>(done => { releaseClaimReply = done; });
    const heldClaim = new Promise<void>(done => { observeHeldClaim = done; });
    let pendingFollowup: Promise<unknown> | undefined;
    const providerStarts = async () => (await readFile(calls, "utf8")).trim().split(/\r?\n/)
      .filter(line => harness === "codex" ? line === "process-start" : JSON.parse(line).processStart).length;
    const state = async () => JSON.parse(await readFile(join(runnerRoot, "runner-state.json"), "utf8"));
    const sameSource = (a: DurableRecoveryIdentity, b: DurableRecoveryIdentity) => Object.entries(a).every(([key, value]) => b[key as keyof DurableRecoveryIdentity] === value);
    const task = async (raw: unknown, authorityRunId: string): Promise<unknown> => {
      const operation = environmentTaskOperationSchema.parse(raw);
      if (claimHeld) operationsDuringClaim.push(operation.kind);
      if (operation.kind === "describe") return { kind: "description", taskId, launchPreparationVersion: 1,
        projectAuthCheckVersion: 1, warmTaskVersion: 1, releaseResumeVersion: 1, runner: artifact, ...(qualifiedCancellation ? { executionContextVersion: 1 } : {}),
        ...(managedGitHub ? { githubCredentialBrokerVersion: 1 } : {}) };
      if (operation.kind === "prepare") {
        expect(operation.requirements.identity.runId).toBe(authorityRunId);
        expect(operation.githubBroker).toEqual(managedGitHub ? { url: brokerUrl, token: brokerToken(authorityRunId) } : undefined);
        preparedBrokers.push({ runId: authorityRunId, token: operation.githubBroker?.token });
        expect(operation.accountIdentity).toBe("fixture-account");
        if (operation.priorIdentity) expect(sameSource(operation.priorIdentity, await state())).toBe(true);
        expect(operation.requirements.settings.managedProfile).toBeUndefined();
        expect(operation.requirements.settings.agentCoreProfile).toBeUndefined();
        expect(operation.requirements.settings.acpxAgent).toBe(harness === "claude" ? "claude" : undefined);
        const requirements = { ...operation.requirements, runtimeContext: operation.requirements.runtimeContext ? parseNativeRuntimeContext(operation.requirements.runtimeContext) : null, settings: { ...operation.requirements.settings, acpxAgent: harness === "claude" ? "claude" as const : undefined, managedProfile: undefined, agentCoreProfile: undefined } };
        const launch = { configurationId: `configuration-${operation.requirements.identity.runId}`, requirementsDigest: runnerLaunchRequirementsDigest(requirements),
          provider: createRunnerProviderLaunch(requirements, { options: { codexArgs: ["--state-file", join(root, "provider.json"), "--terminal-result-file", resultFile,
            "--call-log", calls, "--record-process-start"] }, root, cwd: workspace, codexHome: home, codexCommand: fakeCodexAppServer,
            providerNodeCommand: harness === "claude" ? sidecar : process.execPath, opencodeProxyPath: "", acpxSidecarPath: harness === "claude" ? sidecarScript : "" }) };
        preparations.set(launch.configurationId, { operation, launch }); return { kind: "prepared", taskId, launch };
      }
      if (operation.kind === "check_project_auth") return { kind: "project_auth", taskId, configurationId: operation.configurationId, provider: operation.provider, allowed: true };
      if (operation.kind === "submit") {
        if (!operation.preparedLaunchId || !operation.launch) throw new Error("Fixture structured launch unavailable");
        const prepared = preparations.get(operation.preparedLaunchId)!; submissions++;
        expect(operation.runner).toMatchObject({ runnerId: prepared.operation.requirements.identity.runnerInstanceId,
          leaseId: prepared.operation.requirements.identity.environmentLeaseId, runId: authorityRunId,
          sessionId: prepared.operation.requirements.identity.normalizedSessionId, turnId: prepared.operation.requirements.identity.turnId,
          itemId: prepared.operation.requirements.identity.itemId });
        listenPath = `/api/runner/v1/connect/${operation.runner.runId}`;
        handle = spawnRunner({ ...operation.launch, stateDirectory: runnerRoot, identity: prepared.operation.requirements.identity, ticket: operation.bootstrapTicket,
          runnerBinaryPath: binary, maxOutboxBytes: operation.launch.maxOutboxBytes, p0ReserveBytes: operation.launch.p0ReserveBytes,
          connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: runnerPort, listenPath }, processLauncher: host.launch,
          environment: { PATH: process.env.PATH },
          ...(harness === "claude" ? { acpxLaunchProfile: { authorityDigest: `sha256:${sha("fixture authority")}`, command: sidecar,
            commandSha256: `sha256:${sha(await readFile(sidecar, "utf8"))}`, sidecarScript,
            sidecarScriptSha256: `sha256:${sha(await readFile(sidecarScript, "utf8"))}` } } : {}) });
        return { kind: "accepted", taskId };
      }
      if (operation.kind === "connection") return { kind: "connection", taskId, endpoint: { kind: "authenticated_websocket",
        websocketUrl: `wss://127.0.0.1:${tlsAddress.port}/runner`, secretHeaders: [{ name: "X-Fixture-Token", value: "synthetic-ingress" }], generation: "fixture" } };
      if (operation.kind === "status") return { kind: "status", taskId, phase: handle?.isExitConfirmed?.() ? "cancelled" : "running", executionStopped: handle?.isExitConfirmed?.() ?? false };
      if (operation.kind === "read_state") {
        const live = await state();
        const previous = [...preparations.values()].some(({ operation: prepared }) => prepared.priorIdentity && sameSource(prepared.priorIdentity, operation.identity));
        expect(sameSource(operation.identity, live) || previous).toBe(true);
        return { kind: "state", taskId, state: live };
      }
      if (operation.kind === "release") {
        const live = await state(); const reply = await host.request({ op: "park", id: parkId(operation.identity), identity: operation.identity,
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
        if (heldClaimMode) {
          expect(await processStartRequested(authorityRunId)).toBe(false);
          claimHeld = true;
          await waitForCondition("preparation completes while the claim is held", () => processStartRequested(authorityRunId));
          await new Promise(done => setTimeout(done, 200));
          claimHeld = false;
        }
        if (cancellation) { observeHeldClaim(); await claimReply; }
        return { kind: "resume", taskId, outcome: "resumed" };
      }
      if (operation.kind === "stop") { stops++; await host.close(); }
      if (operation.kind === "complete") { expect(handle?.isExitConfirmed?.()).toBe(true); completes++; }
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
    const execute = async (current: typeof execution, leaseId: string) => {
      await db.update(heartbeatRuns).set({ runnerProfileJson: { nativeExecutionInput: current }, runnerInstanceId: native.runnerInstanceId, completionContractId: contract!.id, completionContractSha256: contract!.canonicalSha256, nativeSessionId: current.session.normalizedSessionId })
        .where(eq(heartbeatRuns.id, current.binding.runId));
      return executePaperclipNativeSession({ db, execution: current, runnerInstanceId: native.runnerInstanceId, useRunnerd: true, runnerIngressAuthorized: true,
        runnerEnvironment: { ...(harness === "claude" ? { ANTHROPIC_API_KEY: "synthetic-fixture" } : {}),
          ...(managedGitHub ? { PAPERCLIP_GITHUB_BROKER_URL: brokerUrl, PAPERCLIP_GITHUB_BROKER_TOKEN: brokerToken(current.binding.runId) } : {}) },
        managedGitHub,
        managedAiCredentialHome: home, managedAiCredentialIdentity: "fixture-revision", managedAiAccountIdentity: "fixture-account", turnTimeoutMs: 15_000,
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", remoteCwd: workspace, environmentId, leaseId, providerKey: "plugin:fixture:tasks", runnerTask: operation => task(operation, current.binding.runId),
          sandboxLeaseAcquisition: { outcome: leaseId === leaseA ? "created" : "resumed", providerLeaseId: taskId } } });
    };
    const adoption = vi.spyOn(remoteWarmRecovery, "inspectRemoteWarmSessionRecovery");
    try {
      setDefaultCACertificates(certificates); https.globalAgent = new https.Agent({ ca: certificates });
      const a = await execute(execution, leaseA); expect(a).toMatchObject({ exitCode: 0, timedOut: false });
      await waitForCondition("automatic release A", () => releases.length === 1);
      expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId)))[0]).toMatchObject({ schemaStatus: "accepted", resultJson: { result: { reportedWorkDisposition: "done" } } });
      expect(await proof()).toMatchObject({ source: releases[0], taskId });
      const providerSessionId = (await supervisor()).snapshot.providerSessionId;
      expect(providerSessionId).toEqual(expect.any(String));
      const pid = handle!.child.pid;
      const { heartbeatService } = await import("../heartbeat.js");
      expect(await heartbeatService(db).prepareIdleWarmNativeSessionsForSleep({ canRetire: () => true }))
        .toEqual({ closed: 0, busy: 0, failed: 0, failures: [] });
      expect(stops).toBe(0); expect(handle!.isExitConfirmed?.()).toBe(false);
      if (adopted) {
        if (restart) {
          expect(await closeIdleWarmNativeSessionsForRestart()).toEqual({ closed: 1, busy: 0, failed: 0, failures: [] });
          expect(await closeIdleWarmNativeSessionsForRestart()).toEqual({ closed: 0, busy: 0, failed: 0, failures: [] });
        } else await new Promise(done => setTimeout(done, 5_200));
        expect(stops).toBe(0); expect(handle!.isExitConfirmed?.()).toBe(false);
        expect(await proof()).toMatchObject({ source: releases[0], taskId });
      }
      expect(readNativeSessionIdleWork()).toBe("none");
      await reconcileNativeFinalizations(db, [runId]);
      expect((await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId)))[0]).toMatchObject({ phase: "committed", leaseOwner: null });
      const admitNext = async () => {
        const runB = randomUUID(), leaseB = randomUUID();
        await db.insert(heartbeatRuns).values({ id: runB, companyId, agentId, nativeIssueId: issueId, status: "running", runtimeMode: "native" });
        await db.insert(nativeRunFinalizations).values({ runId: runB, companyId, issueId, phase: "observed" });
        await db.update(issues).set({ executionRunId: runB, status: "in_progress" }).where(eq(issues.id, issueId));
        await db.insert(environmentLeases).values({ id: leaseB, companyId, environmentId, heartbeatRunId: runB, issueId, executionWorkspaceId: workspaceId,
          provider: "plugin:fixture:tasks", providerLeaseId: taskId, status: "active", leasePolicy: "reuse_by_environment", metadata: { remoteCwd: workspace } });
        const next = { ...execution, binding: { ...execution.binding, runId: runB } };
        if (heldClaimMode) holdPreparationFor = runB;
        pendingFollowup = execute(next, leaseB);
        if (cancellation) {
          void pendingFollowup.catch(() => undefined);
          await heldClaim;
          const competitor = { ...next, binding: { ...next.binding, runId: randomUUID() } };
          await expect(execute(competitor, leaseB)).rejects.toThrow("native_session_supervisor_busy");
          const stopping = cancelNativeSession(runB, "Stop retained adoption", { db });
          void stopping.catch(() => undefined);
          await waitForCondition("durable cancellation intent", async () => Boolean((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runB)))[0]?.resultJson?.nativeCancellation));
          if (qualifiedCancellation) await waitForCondition("Core-triggered native stop", () => stops > 0 && handle!.isExitConfirmed!());
          else await expect(execute(competitor, leaseB)).rejects.toThrow("native_session_supervisor_busy");
          expect(claims).toEqual([releases[0]]);
          expect(releases).toHaveLength(1);
          releaseClaimReply();
          expect(await pendingFollowup.catch(error => error)).toBeInstanceOf(Error);
          await stopping.catch(() => undefined);
          expect(completes).toBeGreaterThan(0);
          expect(handle!.isExitConfirmed!()).toBe(true);
          expect((await readFile(calls, "utf8")).split(/\r?\n/).filter(method => method === "turn/start")).toHaveLength(1);
          expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runB)))).toHaveLength(0);
          expect(releases).toHaveLength(1); expect((await proof())?.source.runId).not.toBe(runB);
          return runB;
        }
        expect(await pendingFollowup).toMatchObject({ exitCode: 0, timedOut: false });
        expect((await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runB)))[0]).toMatchObject({ schemaStatus: "accepted", resultJson: { result: { reportedWorkDisposition: "done" } } });
        await reconcileNativeFinalizations(db, [runB]);
        return runB;
      };
      const runB = await admitNext();
      if (cancellation) return;
      await waitForCondition("automatic release B", () => releases.length === 2);
      expect(await proof()).toMatchObject({ source: releases[1], taskId });
      expect((await supervisor()).snapshot.providerSessionId).toBe(providerSessionId);
      expect(adoption).toHaveBeenCalledTimes(adopted ? 1 : 0);
      if (adopted) expect(adoption.mock.calls[0]![0]).toMatchObject({ identity: releases[0], execution: { binding: { runId: runB } } });
      if (adopted) {
        const runC = await admitNext();
        await waitForCondition("automatic release C", () => releases.length === 3);
        expect(releases[2]!.runId).toBe(runC); expect(await proof()).toMatchObject({ source: releases[2], taskId });
        expect((await supervisor()).snapshot.providerSessionId).toBe(providerSessionId);
        expect(adoption).toHaveBeenCalledTimes(1);
      }
      expect(claims).toEqual(releases.slice(0, -1)); expect(releases[1]!.runId).toBe(runB);
      if (heldClaimMode) expect({ claimedDuringPreparation, operationsDuringClaim }).toEqual({ claimedDuringPreparation: true, operationsDuringClaim: [] });
      expect(releases[1]!.environmentLeaseId).toBe(leaseA); expect(handle!.child.pid).toBe(pid); expect(submissions).toBe(1);
      expect([...new Set(preparedBrokers.map(prepared => prepared.runId))]).toEqual(releases.map(release => release.runId));
      const methods = (await readFile(calls, "utf8")).trim().split(/\r?\n/);
      if (harness === "codex") {
        expect(methods.filter(method => method === "process-start")).toHaveLength(1);
        expect(methods.filter(method => method === "turn/start")).toHaveLength(adopted ? 3 : 2);
      } else {
        const journal = methods.map(line => JSON.parse(line));
        expect(journal.filter(entry => entry.processStart)).toHaveLength(adopted ? 4 : 3);
        expect(journal.filter(entry => entry.command === "turn.start")).toHaveLength(adopted ? 3 : 2);
      }
    } catch (error) {
      const live = await state().catch(() => ({}));
      console.info("entry-fixture", { releases: releases.length, claims: claims.length, lifecycle: live.lifecycle,
        lastCommand: live.lastControllerCommandSeq, ackedSource: live.ackedSourceSeq, outbox: live.outbox?.map((e: { envelope?: { payload?: { eventType?: string } } }) => e.envelope?.payload?.eventType), wire: wireEvents.slice(-70) });
      throw error;
    } finally {
      releaseClaimReply();
      await pendingFollowup?.catch(() => undefined);
      try {
        const cleanup = await Promise.allSettled([closeIdleWarmNativeSessionsForRestart(), host.close()]);
        for (const socket of sockets) socket.terminate(); websocket.close();
        await new Promise<void>(done => tls.close(() => done()));
        const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Fixture cleanup failed");
      } finally {
        adoption.mockRestore(); preparation.mockRestore();
        https.globalAgent.destroy(); https.globalAgent = oldAgent; setDefaultCACertificates(oldCAs);
      }
    }
  });
});
