import { execFile, fork, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Duplex } from "node:stream";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import type { PluginEnvironmentRunnerRecoveryExecuteParams } from "@paperclipai/plugin-sdk";
import { codexSemanticToolSpecs } from "@paperclipai/paperclip-runner";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import * as runnerRuntime from "../../vendor/paperclip-runner/index.js";
import { connectRunnerPrpIngress } from "../../realtime/runner-prp-outbound.js";
import { environmentRuntimeService } from "../environment-runtime.js";
import { readProcessStartedAt } from "../hot-restart.js";
import type { PluginWorkerManager } from "../plugin-worker-manager.js";
import { nativeSha256 } from "./canonical.js";
import { verifyNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { closeWarmNativeSessionsForEnvironment, executePaperclipNativeSession } from "./native-session-executor.js";
import { remoteRunnerRecoveryProcess } from "./remote-runner-recovery.js";
import { createRemoteRunnerRecoveryControls } from "./remote-runner-recovery-controls.js";
import { seedRemoteDispatchFixture } from "./remote-dispatch.test-fixture.js";
import { materializeAsset } from "./runtime-context.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";

const exec = promisify(execFile);
const fakeCodex = resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner/target/debug/fake-codex-app-server");
const support = await getEmbeddedPostgresTestSupport();
const available = support.supported && existsSync(fakeCodex) && existsSync(runnerRuntime.defaultCapabilityRunnerdBinary());
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const json = async (path: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(path, "utf8"));
function alive(pid: number | null) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function waitUntil(label: string, condition: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function stopOwned(pid: number | null, root: string) {
  if (!pid || !alive(pid)) return;
  const command = await exec("ps", ["-p", String(pid), "-o", "command="]);
  if (!command.stdout.includes(root)) throw new Error("Fixture process ownership changed");
  process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
  await waitUntil("fixture exit", () => !alive(pid));
}
async function writableDirectories(root: string) {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) await writableDirectories(join(root, entry.name));
}

// Production executor, backend, TLS/PRP, retained idle controls and checkpoint
// publication. Only the provider RPC/kernel boundary and Codex model are fixtures.
(available ? describe : describe.skip)("remote backend checkpoint through actual runner recovery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>, root: string, key: Buffer, cert: Buffer;
  const oldHome = process.env.PAPERCLIP_HOME, oldState = process.env.PAPERCLIP_RUNNER_STATE_DIR;
  let oldCertificates: string[];
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperclip-backend-checkpoint-"));
    process.env.PAPERCLIP_HOME = root; process.env.PAPERCLIP_RUNNER_STATE_DIR = join(root, "sessions");
    const configuration = join(root, "tls.cnf");
    await writeFile(configuration, "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n");
    await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", configuration,
      "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem")]);
    await chmod(join(root, "key.pem"), 0o600);
    key = await readFile(join(root, "key.pem")); cert = await readFile(join(root, "cert.pem"));
    oldCertificates = getCACertificates("default"); setDefaultCACertificates([...oldCertificates, cert]);
    database = await startEmbeddedPostgresTestDatabase("paperclip-backend-checkpoint-db-"); db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => {
    if (oldCertificates) setDefaultCACertificates(oldCertificates);
    await database?.cleanup();
    if (oldHome === undefined) delete process.env.PAPERCLIP_HOME; else process.env.PAPERCLIP_HOME = oldHome;
    if (oldState === undefined) delete process.env.PAPERCLIP_RUNNER_STATE_DIR; else process.env.PAPERCLIP_RUNNER_STATE_DIR = oldState;
    if (root) { await writableDirectories(root); await rm(root, { recursive: true, force: true }); }
  });

  it.each(["saved", "without_acquisition", "archive_failure", "controller_restart", "unverified_inspection", "controller_handoff", "missing_checkpoint", "changed_checkpoint"] as const)("retains the app and a usable checkpoint (%s)", async outcome => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), issueId = randomUUID();
    const caseRoot = join(root, runId), remoteCwd = join(caseRoot, "remote-workspace"), fixtureHome = join(caseRoot, "empty-home");
    await mkdir(remoteCwd, { recursive: true }); await mkdir(fixtureHome);
    await db.insert(companies).values({ id: companyId, name: "Backend checkpoint", issuePrefix: "B" + companyId.slice(0, 6) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Developer" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Keep this dev server", status: "in_progress", assigneeAgentId: agentId, executionRunId: runId });
    const f = await seedRemoteDispatchFixture(db, { companyId, agentId, runId, issueId, hostCwd: join(caseRoot, "host-workspace"), remoteCwd });
    const execution = structuredClone(f.execution);
    const controllerRecovery = ["controller_restart", "unverified_inspection", "controller_handoff", "missing_checkpoint", "changed_checkpoint"].includes(outcome);
    execution.session.lifecyclePolicy = { mode: "warm", idleTimeoutMs: controllerRecovery ? 180_000 : 60_000 };
    execution.runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", content: Buffer.from("Complete the fixture task.\n"), mode: 0o444 }]);
    execution.runtimeContext.aggregateDigest = runnerRuntime.canonicalNativeRuntimeContextDigest(execution.runtimeContext);
    const identity = { runId, runnerInstanceId: randomUUID(), environmentLeaseId: f.lease.id,
      normalizedSessionId: f.native.normalizedSessionId, turnId: `turn-${runId}`, itemId: `item-${runId}` };
    const stateDirectory = join(process.env.PAPERCLIP_RUNNER_STATE_DIR!, nativeSha256({ schema: "paperclip.native-session-scope.v2", companyId, agentId,
      workspace: { kind: "managed", executionWorkspaceId: execution.binding.executionWorkspaceId },
      provider: { driverKind: execution.session.driverKind, identity: { kind: "codex" } }, normalizedSessionId: identity.normalizedSessionId }));
    const remoteRoot = join(remoteCwd, ".paperclip-runtime/paperclip-runner/sessions", digest(identity.normalizedSessionId));
    const remoteState = join(remoteRoot, "runner"), remoteFilesystem = join(remoteRoot, "filesystem");
    const runnerStateFile = join(remoteState, "runner-state.json"), backup = join(stateDirectory, "failover-backups/current");
    await mkdir(join(remoteFilesystem, "codex-home"), { recursive: true });
    const remoteContext = structuredClone(execution.runtimeContext);
    remoteContext.instructions.bundle.rootPath = join(remoteFilesystem, "context/instructions");
    await cp(execution.runtimeContext.instructions.bundle.rootPath, remoteContext.instructions.bundle.rootPath, { recursive: true });
    await writeFile(join(remoteFilesystem, "runtime-context.json"), JSON.stringify(remoteContext));
    const finishFile = join(caseRoot, "finish.json"), callsFile = join(caseRoot, "calls.log");
    await writeFile(finishFile, JSON.stringify({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "The preview remains running.",
      completionClaim: { contractRevision: execution.completionContract.contract.revision, objectiveSatisfied: true,
        criteria: execution.completionContract.contract.criteria.map(c => ({ criterionId: c.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
      evidence: [], verification: [], attentionRequests: [], artifacts: [] }));
    const args = ["--state-file-in-codex-home", "--call-log", callsFile, "--durable-turn-ids", "--require-existing-resume-state",
      ...(outcome === "controller_handoff" ? ["--durable-tool-ids"] : ["--finish-first-turn-only"]), "--finish-result-file", finishFile];
    // A deterministic model-process fixture applies the second turn's edit
    // before forwarding it. Runner/session/control-plane behavior stays real.
    let codexCommand = fakeCodex;
    if (outcome === "controller_handoff") {
      codexCommand = join(caseRoot, "editing-provider.cjs");
      await writeFile(codexCommand, `#!${process.execPath}\nconst fs=require('node:fs'),{spawn}=require('node:child_process'),{createInterface}=require('node:readline');
const child=spawn(${JSON.stringify(fakeCodex)},process.argv.slice(2),{stdio:['pipe','inherit','inherit']});
const lines=createInterface({input:process.stdin});lines.on('line',line=>{const message=JSON.parse(line);if(message.method==='turn/start'&&JSON.parse(fs.readFileSync(require('node:path').join(process.env.CODEX_HOME,'fake-codex-state.json'),'utf8')).nextTurn===1){fs.writeFileSync(${JSON.stringify(join(remoteCwd, "App.jsx"))},"export default () => 'edited by the next run';\\n");}child.stdin.write(line+'\\n');});lines.on('close',()=>child.stdin.end());child.on('exit',code=>process.exit(code??1));\n`, { mode: 0o700 });
    }
    const sockets = new Set<Duplex>();
    const token = randomUUID(); let route = `/api/runner/v1/connect/${runId}`;
    let upgrades = 0;
    let providerRpc: ((id: string, method: string, params: Record<string, unknown>) => Promise<unknown>) | undefined;
    const proxy = createHttpsServer({ key, cert }, async (req, res) => {
      if (req.method !== "POST" || req.url !== "/fixture-provider" || req.headers["x-fixture-token"] !== token || !providerRpc) {
        res.writeHead(404); res.end(); return;
      }
      try {
        let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 2 * 1024 * 1024) throw new Error("Fixture request too large"); }
        const { pluginId, method, params } = JSON.parse(body);
        const result = await providerRpc(pluginId, method, params);
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify(result));
      } catch (error) { logs.push(`Fixture provider error: ${String(error)}`); res.writeHead(500); res.end(); }
    });
    proxy.on("upgrade", (req, socket, head) => {
      if (req.url !== route || req.headers["x-daytona-preview-token"] !== token) { socket.destroy(); return; }
      upgrades += 1;
      const upstream = connect(43127, "127.0.0.1");
      sockets.add(socket); sockets.add(upstream);
      socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
      socket.on("close", () => { sockets.delete(socket); upstream.destroy(); });
      upstream.on("close", () => { sockets.delete(upstream); socket.destroy(); });
      upstream.once("connect", () => {
        const headers = req.rawHeaders.reduce((s, v, i) => s + (i % 2 ? `${v}\r\n` : `${v}: `), "");
        upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n`);
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
    });
    let first: ReturnType<typeof runnerRuntime.createRunnerdCodexTransport> | undefined;
    let detached = false;
    let recovered: ReturnType<typeof runnerRuntime.createRunnerdCodexTransport> | undefined;
    let restored: ReturnType<typeof runnerRuntime.createRunnerdCodexTransport> | undefined;
    let runnerPid: number | null = null, providerPid: number | null = null, restoredPid: number | null = null;
    let service: ReturnType<typeof spawn> | undefined;
    let capture: MockInstance<typeof runnerRuntime.createRunnerdCodexTransport> | undefined;
    const logs: string[] = [];
    const controllers: Array<{ child: ReturnType<typeof fork>; exited: Promise<number | null>; messages: Record<string, unknown>[] }> = [];
    try {
      const probe = createTcpServer();
      await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(43127, "127.0.0.1", resolve); });
      await new Promise<void>(resolve => probe.close(() => resolve()));
      await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
      const address = proxy.address(); if (!address || typeof address === "string") throw new Error("Missing TLS listener");
      const endpoint: RunnerIngressEndpoint = { kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${address.port}${route}`,
        secretHeaders: [{ name: "X-Daytona-Preview-Token", value: token }], generation: "fixture", refresh: async () => endpoint, close: async () => undefined };
      const appFile = join(remoteCwd, "App.jsx"), portFile = join(caseRoot, "http.json"), serviceToken = randomUUID();
      await writeFile(appFile, "export default () => 'original app';\n");
      service = spawn(process.execPath, ["-e", `const fs=require('node:fs'),http=require('node:http');const [port,source,token]=process.argv.slice(1);const s=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({pid:process.pid,token,source:fs.readFileSync(source,'utf8')}))});s.listen(0,'127.0.0.1',()=>fs.writeFileSync(port,JSON.stringify({port:s.address().port})));`, portFile, appFile, serviceToken], { cwd: remoteCwd, detached: true, stdio: "ignore" });
      await waitUntil("HTTP service", () => existsSync(portFile));
      const serviceBirth = await readProcessStartedAt(service.pid!), url = `http://127.0.0.1:${(await json(portFile)).port}/`;
      const checkService = async () => {
        const response = await fetch(url, { signal: AbortSignal.timeout(2_000) }); expect(response.status).toBe(200);
        const body = await response.json() as { pid: number; token: string; source: string };
        expect(body).toMatchObject({ pid: service!.pid, token: serviceToken }); expect(await readProcessStartedAt(service!.pid!)).toBe(serviceBirth);
        return body;
      };
      first = runnerRuntime.createRunnerdCodexTransport({ runnerBinary: runnerRuntime.defaultCapabilityRunnerdBinary(), codexCommand, codexArgs: args,
        stateDirectory, runnerStateDirectory: remoteState, runnerFilesystemRoot: remoteFilesystem, sourceCodexHome: fixtureHome,
        runtimeContext: execution.runtimeContext, runnerRuntimeContext: remoteContext,
        lifecyclePolicy: execution.session.lifecyclePolicy, prpIdentity: identity, externallySandboxed: true,
        controlPlaneRegistration: async authority => {
          let outbound: ReturnType<typeof connectRunnerPrpIngress> | undefined;
          return { connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: 43127, listenPath: route },
            activate: () => { outbound = connectRunnerPrpIngress({ authority, endpoint, startupDeadlineMs: 10_000 }); },
            ready: async () => { await outbound!.ready; }, release: async () => { await outbound?.close(); } };
        } });
      const opened = await first.transport.request("thread/start", { cwd: remoteCwd, dynamicTools: codexSemanticToolSpecs() });
      const thread = opened.thread as Record<string, unknown>;
      runnerPid = first.evidence().runnerPid; providerPid = first.evidence().providerPid;
      expect(runnerPid).toBeTruthy(); const birth = await readProcessStartedAt(runnerPid!); expect(birth).toBeTruthy();
      await checkService();
      await first.detachControllerForRestart();
      detached = true;
      const processOwner = { ...(f.lease.metadata!.runtimeServiceProcessOwner as Record<string, unknown>), process: {
        version: 1, pid: runnerPid, processGroupId: runnerPid, uid: process.getuid!(), bootId: randomUUID(), startTicks: "100" } };
      const [lease] = await db.update(environmentLeases).set({ metadata: { ...f.lease.metadata, runtimeServiceProcessOwner: processOwner } }).where(eq(environmentLeases.id, f.lease.id)).returning();
      const [run] = await db.update(heartbeatRuns).set({ processPid: runnerPid, processStartedAt: new Date(birth!), runnerInstanceId: identity.runnerInstanceId,
        runnerProfileJson: { ...f.run.runnerProfileJson, turnId: identity.turnId, itemId: identity.itemId, nativeExecutionInput: execution,
          sessionCheckpoint: { backendKind: "runner", sessionId: String(thread.id), providerSessionId: String(thread.sessionId ?? thread.id),
            identity: { companyId, agentId, issueId, runId, sessionId: identity.normalizedSessionId }, workingDirectory: remoteCwd,
            providerRecoveryPolicy: "same_session_only" } } }).where(eq(heartbeatRuns.id, runId)).returning();
      const processReference = remoteRunnerRecoveryProcess(lease!, run!)!; expect(processReference).toBeTruthy();
      const controller = await currentNativeControllerIdentity();
      await db.update(nativeRunFinalizations).set({ controllerBootId: controller.bootId, controllerPid: controller.pid,
        controllerProcessStartedAt: controller.processStartedAt }).where(eq(nativeRunFinalizations.runId, runId));
      const methods = ["environmentRunProcessControl", "environmentRunnerRecovery", "environmentRunnerRecoveryExecute"];
      let copiedArchives = 0;
      let inspectionUnavailable = false;
      const provider = vi.fn(async (_id: string, method: string, params: Record<string, unknown>) => {
        if (method === "fixtureCommand") {
          expect(outcome).toBe("controller_handoff");
          const [active] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, String(params.runId)));
          expect(active).toMatchObject({ companyId, agentId, nativeIssueId: issueId, status: "running" });
          const [lease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, String(params.leaseId)));
          expect(lease).toMatchObject({ heartbeatRunId: active!.id, providerLeaseId: f.lease.providerLeaseId, status: "active" });
          const command = params.command as Parameters<CommandManagedRuntimeRunner["execute"]>[0];
          if (command.env?.PAPERCLIP_REMOTE_PROCESS_CONTROL) {
            const request = JSON.parse(command.env.PAPERCLIP_REMOTE_PROCESS_CONTROL);
            expect(request).toEqual({ owner: processReference.remoteProcessIdentity, operation: { action: "inspect" } });
            return { stdout: JSON.stringify({ state: alive(runnerPid) ? "running" : "exited" }), stderr: "", exitCode: 0, timedOut: false, pid: null, startedAt: null, signal: null };
          }
          const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolveCommand, reject) => {
            const child = execFile(command.command, command.args ?? [], { cwd: remoteCwd, env: { ...process.env, ...command.env },
              timeout: command.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
              if (error && typeof error.code !== "number") reject(error);
              else resolveCommand({ stdout, stderr, exitCode: error?.code as number ?? 0 });
            }); child.stdin?.end(command.stdin);
          });
          return { ...result, timedOut: false, pid: null, startedAt: null, signal: null };
        }
        expect(params).toMatchObject({ owner: processReference.remoteProcessIdentity, workspaceConnection: processReference.workspaceConnection });
        if (method === "environmentRunProcessControl") {
          expect(params.operation).toEqual({ action: "inspect" });
          if (inspectionUnavailable) return { state: "unverified" };
          return { state: alive(runnerPid) ? "running" : "exited", workspaceConnection: processReference.workspaceConnection };
        }
        if (method === "environmentRunnerRecovery") {
          if (typeof params.path === "string") {
            expect(outcome).toBe("controller_handoff");
            expect(params.path).toBe(`/api/runner/v1/connect/${params.runId}`);
            route = params.path;
          }
          return { state: "ready", workspaceConnection: processReference.workspaceConnection,
            ...(params.operation === "ingress" ? { endpoint: { ...endpoint, websocketUrl: `wss://127.0.0.1:${address.port}${route}` } } : { runnerState: await json(runnerStateFile) }) };
        }
        expect(method).toBe("environmentRunnerRecoveryExecute");
        const command = (params as unknown as PluginEnvironmentRunnerRecoveryExecuteParams).execution;
        const archive = command.args?.some(a => a.includes("tar "));
        if (archive) { copiedArchives += 1; expect(alive(runnerPid)).toBe(false); await checkService(); }
        let result;
        if (outcome === "archive_failure" && archive) result = { stdout: "", stderr: "fixture archive failure", exitCode: 1, timedOut: false };
        else result = await new Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>((resolve, reject) => {
          const child = execFile(command.command, command.args ?? [], { cwd: remoteCwd, timeout: command.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") reject(error);
            else resolve({ stdout, stderr, exitCode: error?.code as number ?? 0, timedOut: false });
          }); child.stdin?.end(command.stdin);
        });
        return { state: "executed", workspaceConnection: processReference.workspaceConnection, result };
      });
      const runtime = environmentRuntimeService(db, { pluginWorkerManager: { isRunning: () => true,
        getWorker: () => ({ supportedMethods: methods }), call: provider } as unknown as PluginWorkerManager });
      providerRpc = provider;
      let recoveredController: (typeof controllers)[number] | undefined;
      const controllerMessage = async (controller: (typeof controllers)[number], state: string) => {
        await waitUntil(`controller ${state}`, () => controller.messages.some(message => message.state === state || message.state === "error") || controller.child.exitCode !== null || controller.child.signalCode !== null);
        const error = controller.messages.find(message => message.state === "error");
        if (error) throw new Error(String(error.message));
        const message = controller.messages.find(message => message.state === state);
        if (!message) throw new Error(`Controller exited without ${state}: ${logs.join("")}`);
        return message;
      };
      if (controllerRecovery) {
        const configuration = join(caseRoot, "controller.json");
        await writeFile(configuration, JSON.stringify({ connectionString: database.connectionString, execution, identity, processReference,
          fixtureHome, claim: f.claim, caPath: join(root, "cert.pem"), token, providerUrl: `https://127.0.0.1:${address.port}/fixture-provider` }), { mode: 0o600 });
        const launch = (mode: "active" | "idle") => {
          const child = fork(resolve(import.meta.dirname, "native-remote-idle-controller.fixture.mjs"), [configuration, mode], {
            silent: true, execArgv: ["--import", resolve(import.meta.dirname, "../../../../cli/node_modules/tsx/dist/loader.mjs")],
            env: { ...process.env, PAPERCLIP_HOME: root, PAPERCLIP_RUNNER_STATE_DIR: process.env.PAPERCLIP_RUNNER_STATE_DIR, PAPERCLIP_IN_WORKTREE: "false" },
          });
          const current = { child, messages: [] as Record<string, unknown>[], exited: new Promise<number | null>((resolveExit, reject) => {
            child.once("error", reject); child.once("exit", code => resolveExit(code));
          }) };
          child.on("message", message => current.messages.push(message as Record<string, unknown>));
          child.stdout!.on("data", chunk => logs.push(String(chunk))); child.stderr!.on("data", chunk => logs.push(String(chunk)));
          controllers.push(current); return current;
        };
        const firstController = launch("active");
        await controllerMessage(firstController, "ready");
        const [retainedBeforeRestart] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
        const proof = retainedBeforeRestart!.metadata!.nativeWarmRunnerRetention as { controller: { pid: number }; idleExpiresAt: string };
        expect(proof.controller.pid).toBe(firstController.child.pid);
        const callsBeforeRecovery = await readFile(callsFile, "utf8");
        firstController.child.kill("SIGKILL"); await firstController.exited;
        await checkService();
        const upgradesBeforeRecovery = upgrades;
        if (outcome === "missing_checkpoint" || outcome === "changed_checkpoint") {
          const checkpointPath = join(resolvePaperclipInstanceRoot(), "runtime/paperclip-runner/sessions", `${basename(stateDirectory)}.json`);
          expect(checkpointPath.startsWith(root + "/")).toBe(true);
          if (outcome === "missing_checkpoint") await rm(checkpointPath);
          else {
            const checkpoint = await json(checkpointPath);
            await writeFile(checkpointPath, JSON.stringify({ ...checkpoint, snapshot: { ...checkpoint.snapshot as Record<string, unknown>, cursor: "changed-after-finalization" } }), { mode: 0o600 });
          }
        }
        inspectionUnavailable = outcome === "unverified_inspection";
        recoveredController = launch("idle");
        let recoveredMessage = await controllerMessage(recoveredController, "ready");
        if (inspectionUnavailable) {
          expect(recoveredMessage.result, logs.join("")).toMatchObject({ state: "unavailable", runId });
          expect(recoveredMessage.admission).toBe("native_remote_runner_idle_recovery_pending");
          const [held] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
          expect(held!.metadata!.nativeWarmRunnerRetention).toEqual(retainedBeforeRestart!.metadata!.nativeWarmRunnerRetention);
          expect(upgrades).toBe(upgradesBeforeRecovery); expect(copiedArchives).toBe(0);
          expect(await readProcessStartedAt(runnerPid!)).toBe(birth); await checkService();
          expect((await readFile(callsFile, "utf8")).match(/^turn\/start$/gm)).toEqual(callsBeforeRecovery.match(/^turn\/start$/gm));
          inspectionUnavailable = false;
          recoveredController.child.send({ action: "recover" });
          recoveredMessage = await controllerMessage(recoveredController, "recovery_retry");
        }
        expect((await readFile(callsFile, "utf8")).match(/^turn\/start$/gm)).toEqual(callsBeforeRecovery.match(/^turn\/start$/gm));
        const [afterRecovery] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
        if (outcome === "missing_checkpoint" || outcome === "changed_checkpoint") {
          expect(recoveredMessage.result, logs.join("")).toMatchObject({ state: "unavailable", runId });
          expect(recoveredMessage.admission).toBe("native_remote_runner_idle_recovery_pending");
          expect(afterRecovery!.metadata!.nativeWarmRunnerRetention).toMatchObject({ idleExpiresAt: proof.idleExpiresAt,
            controllerTakeover: { authority: { pid: recoveredController.child.pid }, reconnection: { state: "failed" } } });
          expect(upgrades).toBe(upgradesBeforeRecovery); expect(copiedArchives).toBe(0);
          expect(alive(runnerPid)).toBe(true); expect(existsSync(backup)).toBe(false);
          expect(await readProcessStartedAt(runnerPid!)).toBe(birth); await checkService();
          expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!.status).toBe("succeeded");
          return;
        }
        expect(recoveredMessage.result, logs.join("")).toMatchObject({ state: "recovered", runId });
        expect(recoveredMessage.admission).toBe("admitted");
        expect(recoveredMessage.replay).toMatchObject({ results: [{ runId, state: "already_supervised" }] });
        expect(afterRecovery!.metadata!.nativeWarmRunnerRetention).toMatchObject({ idleExpiresAt: proof.idleExpiresAt,
          controllerTakeover: { authority: { pid: recoveredController.child.pid }, reconnection: { state: "attached" } } });
        expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!.status).toBe("succeeded");
        expect(await readProcessStartedAt(runnerPid!)).toBe(birth); await checkService();
        if (outcome === "controller_handoff") {
          recoveredController.child.send({ action: "next_run" });
          const next = await controllerMessage(recoveredController, "next_run_completed");
          expect(next.runId).not.toBe(runId); expect(next.leaseId).not.toBe(f.lease.id);
          expect(next.receivedProcesses).toBeGreaterThan(0);
          const [nextRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, String(next.runId)));
          expect(nextRun).toMatchObject({ status: "succeeded", processPid: runnerPid, processLocation: "remote", nativeSessionId: identity.normalizedSessionId });
          expect(nextRun!.processStartedAt!.toISOString()).toBe(new Date(birth!).toISOString());
          const [nextLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, String(next.leaseId)));
          expect(nextLease!.metadata!.runtimeServiceProcessOwner).toMatchObject({ runId: next.runId, process: processReference.remoteProcessIdentity });
          expect(nextLease!.metadata!.nativeWarmRunnerRetention).toMatchObject({ runId: next.runId, controller: { pid: recoveredController.child.pid } });
          expect(await readProcessStartedAt(runnerPid!)).toBe(birth);
          expect((await checkService()).source).toContain("edited by the next run");
          const calls = await readFile(callsFile, "utf8");
          expect(calls.match(/^thread\/start$/gm)).toHaveLength(1); expect(calls.match(/^turn\/start$/gm)).toHaveLength(2);
          recoveredController.child.send({ action: "close" });
          expect((await controllerMessage(recoveredController, "closed")).result).toEqual({ closed: 1, busy: 0, failed: 0 });
          expect(await recoveredController.exited).toBe(0);
          expect(alive(runnerPid)).toBe(false); await checkService();
          const [closedLease] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, String(next.leaseId)));
          expect(closedLease!.metadata!.nativeWarmRunnerClose).toMatchObject({ state: "closed", checkpoint: { version: 1 } });
          return;
        }
      } else {
      const controls = createRemoteRunnerRecoveryControls({ companyId, runId, process: processReference, runtime });
      const commandRunner: CommandManagedRuntimeRunner = { execute: async command => ({ ...await controls.execute(command), pid: null, startedAt: null, signal: null }) };
      capture = vi.spyOn(runnerRuntime, "createRunnerdCodexTransport");
      const result = await executePaperclipNativeSession({ db, environmentRuntime: runtime, execution, runnerInstanceId: identity.runnerInstanceId,
        leaseOwner: f.claim.leaseOwner, restartRecovery: { ...f.claim, process: processReference }, useRunnerd: true, runnerIngressAuthorized: true,
        runnerEnvironment: { HOME: fixtureHome, CODEX_HOME: fixtureHome, PATH: process.env.PATH },
        onLog: async (_stream, chunk) => { logs.push(chunk); },
        runnerExecutionTarget: { kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId: f.environment.id,
          leaseId: f.lease.id, remoteCwd, runner: commandRunner, nativeRunnerRecovery: controls.nativeRunnerRecovery,
          getRunnerIngressEndpoint: controls.getRunnerIngressEndpoint, effectiveCapabilities: { runnerWebSocketIngress: true, reusableLeases: true },
          reusableLeaseConfigured: true,
          ...(outcome !== "without_acquisition" ? { sandboxLeaseAcquisition: { outcome: "resumed", providerLeaseId: f.lease.providerLeaseId! } } : {}),
        } as never });
      expect(result.errorMessage, logs.join("")).toBeFalsy();
      expect(capture).toHaveBeenCalledOnce();
      recovered = capture.mock.results[0]!.value as typeof recovered;
      expect(capture.mock.calls[0]![0]).toMatchObject({ stateDirectory, runnerStateDirectory: remoteState, runnerFilesystemRoot: remoteFilesystem });
      expect(recovered!.evidence().runnerPid).toBe(runnerPid); expect(await readProcessStartedAt(runnerPid!)).toBe(birth);
      await checkService();
      const [retained] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(retained!.metadata?.nativeWarmRunnerRetention).toMatchObject({ runId, runnerIdentity: identity });
      await db.update(nativeRunFinalizations).set({ phase: "committed" }).where(eq(nativeRunFinalizations.runId, runId));
      await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
      }
      let closed;
      if (recoveredController) {
        recoveredController.child.send({ action: "close" });
        closed = (await controllerMessage(recoveredController, "closed")).result;
        expect(await recoveredController.exited).toBe(0);
      } else closed = await closeWarmNativeSessionsForEnvironment({ environmentId: f.environment.id, reason: "fixture user finished previewing" });
      expect(closed, logs.join("")).toEqual(outcome === "archive_failure" ? { closed: 0, busy: 0, failed: 1 } : { closed: 1, busy: 0, failed: 0 });
      const [finished] = await db.select().from(environmentLeases).where(eq(environmentLeases.id, f.lease.id));
      expect(alive(runnerPid)).toBe(false); await checkService();
      expect(copiedArchives).toBeGreaterThan(0); expect(upgrades).toBeGreaterThanOrEqual(2);
      if (outcome === "archive_failure") {
        expect(finished!.metadata?.nativeWarmRunnerClose).toMatchObject({ state: "closing" });
        expect(finished!.metadata).not.toHaveProperty("nativeHarnessBackup"); expect(existsSync(backup)).toBe(false);
      } else {
        expect(finished!.metadata?.nativeWarmRunnerClose).toMatchObject({ state: "closed", checkpoint: { version: 1 } });
        expect(verifyNativeHarnessBackupStamp(finished!.metadata?.nativeHarnessBackup, f.lease.providerLeaseId!, identity)).not.toBeNull();
        expect((await json(join(backup, "manifest.json"))).sourceProviderLeaseId).toBe(f.lease.providerLeaseId);
        const restoredRoot = join(caseRoot, "restored-session");
        await cp(backup, restoredRoot, { recursive: true });
        await cp(join(stateDirectory, "control-plane"), join(restoredRoot, "control-plane"), { recursive: true });
        await writableDirectories(remoteRoot); await rm(remoteRoot, { recursive: true });
        restored = runnerRuntime.createRunnerdCodexTransport({ runnerBinary: runnerRuntime.defaultCapabilityRunnerdBinary(), codexCommand: fakeCodex,
          codexArgs: args, stateDirectory: restoredRoot, sourceCodexHome: fixtureHome,
          runtimeContext: execution.runtimeContext,
          lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null }, resumeDynamicTools: [],
          prpIdentity: { ...identity, runId: randomUUID(), turnId: randomUUID(), itemId: randomUUID() } });
        const resumed = await restored.transport.request("thread/read", {}); expect(resumed.thread).toMatchObject({ id: thread.id });
        restoredPid = restored.evidence().runnerPid;
        await restored.transport.request("turn/start", { input: [{ type: "text", text: "Continue the same app" }] });
        for await (const event of restored.transport.notifications()) if (event.method === "turn/completed") break;
        await writeFile(appFile, "export default () => 'continued app';\n"); expect((await checkService()).source).toContain("continued app");
        await restored.transport.close(); await checkService();
        const calls = await readFile(callsFile, "utf8"); expect(calls.match(/^thread\/start$/gm)).toHaveLength(1); expect(calls.match(/^turn\/start$/gm)).toHaveLength(2);
      }
    } catch (error) {
      const state = await json(runnerStateFile).catch(() => null);
      const calls = await readFile(callsFile, "utf8").catch(() => "");
      throw new Error(`${String(error)}\n${logs.join("")}\nRunner state: ${JSON.stringify(state)}\nProvider calls: ${calls}\nInitial transport: ${JSON.stringify(first?.evidence())}`, { cause: error });
    } finally {
      for (const controller of controllers) { if (controller.child.exitCode === null) controller.child.kill("SIGKILL"); await controller.exited; }
      recovered ??= capture?.mock.results.find(result => result.type === "return")?.value as typeof recovered;
      restoredPid ??= restored?.evidence().runnerPid ?? null;
      const restoredProviderPid = restored?.evidence().providerPid ?? null;
      capture?.mockRestore();
      if (!detached) await first?.transport.close().catch(() => undefined);
      await recovered?.transport.close().catch(() => undefined);
      await restored?.transport.close().catch(() => undefined);
      // The detached first controller cannot claim ownership during teardown.
      await stopOwned(restoredPid, caseRoot);
      await stopOwned(restoredProviderPid, caseRoot);
      await stopOwned(runnerPid, caseRoot);
      await stopOwned(providerPid, caseRoot);
      await stopOwned(service?.pid ?? null, caseRoot);
      for (const socket of sockets) socket.destroy();
      if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  }, 120_000);
});
