import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import https, { createServer as createHttpsServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { eq, sql } from "drizzle-orm";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { beforeAll, expect, it, vi } from "vitest";
import { completionContracts, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults } from "@paperclipai/db";
import type { RunnerIngressEndpoint } from "@paperclipai/adapter-utils/runner-connectivity";
import { environmentRunnerIngressErrorData, JsonRpcCallError, PluginEnvironmentRunnerIngressError } from "@paperclipai/plugin-sdk";
import { canonicalNativeRuntimeContextDigest, createNativeSessionBackend, createRunnerdCodexTransport, parseNativeExecutionInput,
  type RunnerProcessHandle } from "../../vendor/paperclip-runner/index.js";
import { nativeRestartFixture, describeEmbeddedPostgres, stopOwnedProcessGroup } from "../../__tests__/helpers/native-restart.js";
import { canonicalNativeJson, nativeSha256 } from "./canonical.js";
import { executePaperclipNativeSession, nativeSessionWorkspaceScope, resolveNativeBilling } from "./native-session-executor.js";
import { createNativeRunnerExecutionDriver } from "./native-runner-execution-driver.js";
import { claimNativeSessionResumptions, reconcileNativeFinalizations } from "./native-finalization-reconciler.js";
import { currentNativeControllerIdentity } from "./native-restart-recovery.js";
import { loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";
import { buildNativeCompletionContract } from "./completion-contracts.js";
import { releaseMaterializedNativeRuntimeSkills, spawnRunner } from "../../vendor/paperclip-runner/testing.js";
import { materializeAsset } from "./runtime-context.js";
import { nativeRuntimeContextFixture } from "./runtime-context.test-fixture.js";
import { createNativeUsageDelivery } from "./native-usage-delivery.js";
import { accountRunCost } from "../run-cost-accounting.js";

describeEmbeddedPostgres("native ingress bootstrap retry through the real Runner", () => {
  const environment = nativeRestartFixture();
  const runnerWorkspace = resolve(import.meta.dirname, "../../../../packages/paperclip-runner/runner");
  const runnerBinary = join(runnerWorkspace, "target/release/paperclip-runnerd");
  const fakeProvider = join(runnerWorkspace, "target/release/fake-codex-app-server");

  beforeAll(() => {
    execFileSync(process.execPath, [resolve(runnerWorkspace, "../scripts/build-verified-provider-entrypoints.mjs")],
      { cwd: resolve(runnerWorkspace, ".."), stdio: "pipe", timeout: 30_000 });
    execFileSync("cargo", ["build", "--release", "--locked", "-p", "paperclip-runner-core",
      "--bin", "paperclip-runnerd", "--bin", "fake-codex-app-server"],
    { cwd: runnerWorkspace, stdio: "ignore", timeout: 600_000 });
  }, 660_000);

  it.each(["codex", "opencode"] as const)("reacquires %s ingress and commits exactly one result on the automatic second attempt", async provider => {
    const fixture = await environment.seedRun(`INGRESS-BOOTSTRAP-RETRY-${provider}`);
    const { db, runId, issueId, native } = fixture;
    const { companyId, agentId, runtimeRoot } = environment.current;
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const [contract] = await db.select().from(completionContracts).where(eq(completionContracts.issueId, issueId));
    const sandbox = join(runtimeRoot, `ingress-sandbox-${provider}`);
    const stateBase = join(runtimeRoot, `ingress-controller-${provider}`);
    const codexHome = join(runtimeRoot, `ingress-codex-home-${provider}`);
    const filesystem = join(runtimeRoot, `ingress-filesystem-${provider}`);
    await mkdir(sandbox, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await mkdir(join(filesystem, "codex-home"), { recursive: true });
    await db.insert(executionWorkspaces).values({ id: runId, companyId, sourceIssueId: issueId,
      mode: "isolated", strategyType: "directory", name: "Owned retry fixture", cwd: sandbox });
    await db.update(issues).set({ executionWorkspaceId: runId }).where(eq(issues.id, issueId));
    const runtimeContext = nativeRuntimeContextFixture();
    const skillContent = "---\nname: retry-fixture\ndescription: Controlled sealed retry skill.\n---\nKeep the admitted task and configuration.\n";
    runtimeContext.instructions.bundle = await materializeAsset([{ path: "AGENTS.md", mode: 0o444,
      content: Buffer.from("Complete only the controlled fixture task.\n") }]);
    if (provider === "codex") runtimeContext.skills = [{ key: "company/retry-fixture", runtimeName: "retry-fixture",
      versionId: "fixture-v1", bundle: await materializeAsset([{ path: "SKILL.md", mode: 0o444, content: Buffer.from(skillContent) }]) }];
    runtimeContext.aggregateDigest = canonicalNativeRuntimeContextDigest(runtimeContext);
    const execution = parseNativeExecutionInput({
      schema: "paperclip.native-execution-input.v5", executionMode: "default", planningContext: null, runtimeContext,
      binding: { companyId, agentId, issueId, runId, executionWorkspaceId: runId },
      provider: provider === "codex" ? { kind: "codex", model: "fixture-model", approvalPolicy: "never" }
        : { kind: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", permissionMode: "allow" },
      task: { identifier: "fixture", title: issue!.title, description: null,
        prompt: "Complete the controlled fixture task.", workMode: "standard" },
      workspace: { cwd: sandbox, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: native.normalizedSessionId, driverKind: provider === "codex" ? "codex_app_server" : "opencode_server", protocolVersion: 1,
        lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      completionContract: { id: contract!.id, sha256: contract!.canonicalSha256, schemaVersion: "paperclip.completion-contract.v1",
        contract: buildNativeCompletionContract(issue!, { revision: contract!.revision }) }, interactionResponses: [], credentialBindings: [],
    });
    await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb)
      || ${JSON.stringify({ nativeExecutionInput: execution })}::jsonb` }).where(eq(heartbeatRuns.id, runId));
    const root = join(stateBase, nativeSha256({ schema: "paperclip.native-session-scope.v2", companyId, agentId,
      workspace: nativeSessionWorkspaceScope(execution), provider: { driverKind: execution.session.driverKind,
        identity: { kind: provider } }, normalizedSessionId: native.normalizedSessionId }));
    const digest = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
    const opencode = join(runtimeRoot, "fake-opencode-ingress");
    const providerNode = provider === "opencode" && process.platform === "linux"
      ? join(runtimeRoot, "node") : process.execPath;
    const providerCalls = join(sandbox, "provider-calls.log");
    if (provider === "opencode") {
      if (process.platform === "linux") {
        await copyFile(process.execPath, providerNode);
        await chmod(providerNode, 0o500);
      }
      const script = resolve(runnerWorkspace, "../test/fixtures/fake-opencode-server.mjs");
      execFileSync("cc", ["-x", "c", "-o", opencode, "-"], { input:
        `#include <unistd.h>\n#include <stdlib.h>\n#include <stdio.h>\nint main(int argc, char **argv) { FILE *log = fopen(${JSON.stringify(providerCalls)}, "a"); if (!log) return 126; fputs("process-start\\n", log); fclose(log); char **args = calloc(argc + 2, sizeof(char *)); args[0] = ${JSON.stringify(providerNode)}; args[1] = ${JSON.stringify(script)}; for (int i = 1; i < argc; i++) args[i + 1] = argv[i]; execv(args[0], args); return 127; }` });
      await chmod(opencode, 0o755);
    }
    const proxy = join(filesystem, "opencode-app-server-proxy.cjs");
    if (provider === "opencode") await copyFile(resolve(runnerWorkspace, "../dist/cli/opencode-app-server-proxy.cjs"), proxy);
    const identity = { runnerInstanceId: native.runnerInstanceId, environmentLeaseId: runId, runId,
      normalizedSessionId: native.normalizedSessionId, turnId: `turn-${runId}`, itemId: `item-${runId}` };
    const assertSealedSkills = async () => {
      if (provider !== "codex") return;
      const skill = join(root, "codex-home", "skills", "retry-fixture", "SKILL.md");
      expect(await readFile(skill, "utf8")).toBe(skillContent);
      expect((await stat(skill)).mode & 0o222).toBe(0);
      expect((await stat(join(root, "codex-home", "skills", "retry-fixture"))).mode & 0o222).toBe(0);
    };
    const resultFile = join(sandbox, "fixture-result.json");
    await writeFile(resultFile, canonicalNativeJson({ schema: "paperclip.run_result.v1", reportedWorkDisposition: "done",
      summary: "Controlled retry completed.", completionClaim: { contractRevision: execution.completionContract.contract.revision,
        objectiveSatisfied: true, criteria: execution.completionContract.contract.criteria.map(criterion => ({
          criterionId: criterion.id, status: "satisfied", evidenceRefs: [] })), remainingWork: [] },
      evidence: [], verification: [], artifacts: [], attentionRequests: [] }));
    const key = join(sandbox, "preview.key"), certificate = join(sandbox, "preview.crt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate,
      "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
    const previousCertificates = getCACertificates("default");
    const certificates = [...previousCertificates, await readFile(certificate, "utf8")];
    setDefaultCACertificates(certificates);
    const previousHttpsAgent = https.globalAgent;
    const fixtureHttpsAgent = new https.Agent({ ca: certificates });
    https.globalAgent = fixtureHttpsAgent;
    const portProbe = createTcpServer();
    await new Promise<void>(done => portProbe.listen(0, "127.0.0.1", done));
    const address = portProbe.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture port");
    const runnerPort = address.port;
    let healthy = false, acquisitions = 0, previewUrl = "";
    const preview = createHttpsServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
      if (request.url !== "/preview") { response.writeHead(404).end(); return; }
      acquisitions++;
      response.writeHead(healthy ? 200 : 502, { "content-type": "application/json" });
      response.end(JSON.stringify(healthy ? { url: previewUrl, token: "fixture-preview" } : { message: "fixture upstream unavailable" }));
    });
    const sockets = new Set<WebSocket>();
    const websocket = new WebSocketServer({ noServer: true });
    preview.on("upgrade", (request, socket, head) => {
      if (request.url !== `/api/runner/v1/connect/${runId}` || request.headers["x-fixture-preview-token"] !== "fixture-preview") {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); return;
      }
      websocket.handleUpgrade(request, socket, head, front => {
        const back = new WebSocket(`ws://127.0.0.1:${runnerPort}${request.url}`, { perMessageDeflate: false });
        const pending: Array<{ data: RawData; binary: boolean }> = [];
        sockets.add(front); sockets.add(back);
        front.on("message", (data, binary) => {
          if (back.readyState === WebSocket.OPEN) back.send(data, { binary });
          else pending.push({ data, binary });
        });
        back.on("open", () => { for (const message of pending.splice(0)) back.send(message.data, { binary: message.binary }); });
        back.on("message", (data, binary) => { if (front.readyState === WebSocket.OPEN) front.send(data, { binary }); });
        front.on("close", () => { sockets.delete(front); back.terminate(); });
        back.on("close", () => { sockets.delete(back); front.terminate(); });
        front.on("error", error => { diagnostics.push(`fixture front: ${error.message}`); back.terminate(); });
        back.on("error", error => { diagnostics.push(`fixture back: ${error.message}`); front.terminate(); });
      });
    });
    preview.on("tlsClientError", error => { diagnostics.push(`fixture TLS: ${error.message}`); });
    try {
      await new Promise<void>(done => preview.listen(0, "127.0.0.1", done));
    } finally { await new Promise<void>(done => portProbe.close(() => done())); }
    const previewAddress = preview.address();
    if (!previewAddress || typeof previewAddress === "string") throw new Error("Missing preview address");
    expect(previewAddress.port).not.toBe(runnerPort);
    previewUrl = `wss://127.0.0.1:${previewAddress.port}/api/runner/v1/connect/${runId}`;
    const bundles: ReturnType<typeof createRunnerdCodexTransport>[] = [];
    const handles: RunnerProcessHandle[] = [];
    const diagnostics: string[] = [];
    let usageDelivery: Awaited<ReturnType<typeof createNativeUsageDelivery>> | undefined;
    vi.stubEnv("PAPERCLIP_RUNNER_STATE_DIR", stateBase);
    const endpoint: () => Promise<RunnerIngressEndpoint> = async () => {
      const response = await fetch(`https://127.0.0.1:${previewAddress.port}/preview`);
      if (!response.ok) {
        const error = new PluginEnvironmentRunnerIngressError({ phase: "private_preview", httpStatus: response.status });
        throw new JsonRpcCallError({ code: -32000, message: error.message, data: environmentRunnerIngressErrorData(error) });
      }
      return { kind: "authenticated_websocket" as const, websocketUrl: previewUrl,
        secretHeaders: [{ name: "X-Fixture-Preview-Token", value: "fixture-preview" }], generation: "fixture",
        refresh: endpoint, close: async () => {} };
    };
    const target = { kind: "remote", transport: "sandbox", remoteCwd: sandbox, leaseId: randomUUID(),
      effectiveCapabilities: { runnerWebSocketIngress: true }, getRunnerIngressEndpoint: endpoint } as never;
    const backend = () => createNativeSessionBackend(execution, {
      runnerInstanceId: native.runnerInstanceId, environment: { CODEX_HOME: codexHome, PATH: process.env.PATH },
      codexTransportFactory: () => {
        let started!: () => void;
        const processStarted = new Promise<void>(done => { started = done; });
        const bundle = createRunnerdCodexTransport({
          provider, runnerBinary, codexCommand: fakeProvider, codexArgs: ["--state-file", join(sandbox, "provider.json"),
            "--terminal-result-file", resultFile, "--call-log", providerCalls, "--record-process-start"],
          stateDirectory: root, runnerStateDirectory: join(sandbox, "runner"), runnerFilesystemRoot: filesystem,
          runtimeContext, runnerRuntimeContext: runtimeContext, closeGraceMs: 1_000,
          onDiagnostic: message => { diagnostics.push(message); },
          onAccountingEvent: async event => { await usageDelivery?.capture(event); },
          environment: { CODEX_HOME: codexHome, PATH: process.env.PATH, OPENROUTER_API_KEY: "synthetic-fixture-key" }, sourceCodexHome: codexHome,
          ...(provider === "opencode" ? { opencodeCommand: opencode, opencodeCommandSha256: digest(opencode),
            opencodeProxyPath: proxy, opencodeProxySha256: digest(proxy), providerNodeCommand: providerNode,
            providerNodeCommandSha256: digest(providerNode), opencodePermissionMode: "allow" as const } : {}),
          prpIdentity: identity, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null },
          controlPlaneRegistration: async authority => {
            const controller = await currentNativeControllerIdentity();
            return createNativeRunnerExecutionDriver({ target, binding: execution.binding,
              runnerIngressAuthorized: true,
              prepareRemote: async () => { await copyFile(join(root, "runtime-context.json"), join(filesystem, "runtime-context.json")); },
              processStarted,
              onLog: async (_stream, message) => { diagnostics.push(message); },
              controllerPersistence: { db, bootId: controller.bootId } }).controlPlaneRegistration!(authority);
          },
          runnerProcessLauncher: spec => {
            const handle = spawnRunner({ ...spec.nativeRunner!, runnerBinaryPath: spec.command, environment: spec.environment,
              connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: runnerPort,
                listenPath: `/api/runner/v1/connect/${runId}` } });
            (handle.child as ChildProcess).once("spawn", started);
            handles.push(handle); return handle;
          },
        });
        bundles.push(bundle); return bundle.transport;
      },
    });
    const execute = (leaseOwner?: string) => executePaperclipNativeSession({ db, execution,
      runnerInstanceId: native.runnerInstanceId, useRunnerd: true, runnerExecutionTarget: target,
      backend: backend(), leaseOwner, turnTimeoutMs: 15_000 });
    try {
      await expect(execute()).rejects.toThrow("HTTP 502");
      expect(acquisitions).toBe(1);
      expect(handles).toHaveLength(0);
      await assertSealedSkills();
      const saved = await loadNativeRunnerCheckpoint(db, execution.binding);
      expect(saved?.records.size).toBe(4);
      const savedBootstrapIds = [...saved!.records].filter(([part]) => part.startsWith("command:"))
        .map(([, value]) => JSON.parse(value).commandId);
      expect(savedBootstrapIds).toHaveLength(2);
      const [beforeRetry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(beforeRetry.usageJson?.accountingProviderWorkStarted).not.toBe(false);
      expect(beforeRetry.costAccountedAt).toBeNull();
      const [failed] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(failed).toMatchObject({ phase: "retryable_failure", attempt: 1, failureDetail: { recoveryMode: "bootstrap_retry" } });
      const [claim] = await claimNativeSessionResumptions({ db, runnerInstanceId: "fixture-resumption", runIds: [runId],
        now: new Date(failed!.nextAttemptAt!.getTime() + 1), deferIneligible: false });
      expect(claim).toBeDefined();
      usageDelivery = await createNativeUsageDelivery(db, { companyId, runId, runnerInstanceId: native.runnerInstanceId,
        provider: execution.provider, billing: resolveNativeBilling(execution.provider) });
      healthy = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const retry = execute(claim!.leaseOwner);
      try {
        await expect(Promise.race([retry, new Promise<never>((_done, reject) => {
          timer = setTimeout(() => reject(new Error(`Controlled retry deadline exceeded: ${diagnostics.slice(-12).join("\n")}`)), 20_000);
        })])).resolves.toMatchObject({ exitCode: 0, timedOut: false });
      } finally { if (timer) clearTimeout(timer); }
      expect(acquisitions).toBe(2);
      expect(handles).toHaveLength(1);
      await assertSealedSkills();
      const completed = await loadNativeRunnerCheckpoint(db, execution.binding);
      const commands = [...completed!.records].filter(([part]) => part.startsWith("command:")).map(([, value]) => JSON.parse(value));
      expect(commands.filter(command => command.type === "run.prepare")).toHaveLength(1);
      expect(commands.filter(command => command.type === "session.open")).toHaveLength(1);
      expect(commands.filter(command => ["run.prepare", "session.open"].includes(command.type))
        .map(command => command.commandId)).toEqual(savedBootstrapIds);
      expect((await readFile(providerCalls, "utf8")).split("\n").filter(line => line === "process-start")).toHaveLength(1);
      const results = await db.select().from(nativeRunResults).where(eq(nativeRunResults.runId, runId));
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ schemaStatus: "accepted" });
      await reconcileNativeFinalizations(db, [runId]);
      const [settled] = await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId, runId));
      expect(settled).toMatchObject({ phase: "committed", attempt: 2 });
      const [completedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(completedRun.usageJson?.accountingProviderWorkStarted).not.toBe(false);
      expect(completedRun.usageJson?.accountingReceiptReady).toBe(true);
      expect(Number(completedRun.usageJson?.inputTokens)).toBeGreaterThan(0);
      expect(await accountRunCost(db, runId)).toBe(true);
      expect(await accountRunCost(db, runId)).toBe(false);
      const [accountedRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
      expect(accountedRun.costAccountedAt).toBeInstanceOf(Date);
    } finally {
      for (const bundle of bundles) await bundle.transport.close().catch(() => undefined);
      for (const handle of handles) await stopOwnedProcessGroup(handle.child.pid ?? null, sandbox);
      if (provider === "codex") await releaseMaterializedNativeRuntimeSkills(join(root, "codex-home", "skills"));
      for (const socket of sockets) socket.terminate();
      websocket.close(); preview.closeAllConnections();
      await new Promise<void>(done => preview.close(() => done()));
      https.globalAgent = previousHttpsAgent;
      fixtureHttpsAgent.destroy();
      setDefaultCACertificates(previousCertificates);
      vi.unstubAllEnvs();
    }
  }, 60_000);
});
