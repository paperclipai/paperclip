import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import WebSocket from "ws";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createRunnerProviderLaunch, runnerLaunchRequirementsDigest, type RunnerProviderLaunchRequirements } from "@paperclipai/paperclip-runner";
import { environmentTaskOperationSchema, type PluginEnvironmentTaskOperation, type PluginEnvironmentTaskResult } from "@paperclipai/plugin-sdk";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import { parseRunnerHarnessReleaseIdentity } from "@paperclipai/runner-sdk/contracts";
import { readRunnerdArtifactBinding, type RunnerProcessHandle, type RunnerProcessLaunchSpec } from "../../vendor/paperclip-runner/index.js";
import * as nativeRunner from "../../vendor/paperclip-runner/index.js";
import type { ResolvedRunnerHarness } from "../runner-harness-registry.js";
import { probePluginRunnerEnvironment } from "./plugin-runner-probe.js";

const { spawnRunner } = await import(new URL("../../../../packages/paperclip-runner/src/control-plane/durable-prp-control-plane.ts", import.meta.url).href) as {
  spawnRunner: (options: Record<string, unknown>) => RunnerProcessHandle;
};

// Keep the actual encrypted PRP and native Runner. Only the fixture's loopback
// ingress replaces the provider's TLS endpoint and reconnect implementation.
vi.mock("../../realtime/runner-prp-outbound.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../../realtime/runner-prp-outbound.js")>();
  return { ...actual, connectRunnerPrpIngress: ({ authority, endpoint }: Parameters<typeof actual.connectRunnerPrpIngress>[0]) => {
    const socket = new WebSocket(endpoint.websocketUrl.replace("wss:", "ws:"), { perMessageDeflate: false });
    const wire = new actual.WsJsonWireConnection(socket);
    const attachment = authority.attachWireConnection(wire);
    const ready = new Promise<void>((resolveReady, reject) => {
      const interval = setInterval(() => { if (attachment.isAuthenticated()) { clearInterval(interval); resolveReady(); } }, 10);
      socket.once("error", error => { clearInterval(interval); reject(error); });
      socket.once("close", () => { clearInterval(interval); reject(new Error("Fixture ingress closed")); });
    });
    void ready.catch(() => {});
    return { ready, failure: new Promise<never>(() => {}), close: async () => { wire.close(); } };
  } };
});

const digest = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const credentialIdentity = `sha256:${"d".repeat(64)}`;
const runtime = `const fs=require('node:fs'),readline=require('node:readline');
let provider,sequence=0,commands=[];
const reply=(id,result)=>process.stdout.write(JSON.stringify({schema:'paperclip.harness.v1',id,ok:true,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const {id,method,params}=JSON.parse(line);
  if(method==='initialize'){
    provider=params.provider;
    if(provider.readOnly!==true||provider.runtimeContext!==null||provider.instructions!=='You are a Paperclip agent.'
      ||process.env.UNRELATED_SECRET||process.env.SYNTHETIC_API_KEY!=='selected-key')throw Error('unsafe probe');
    fs.writeFileSync(provider.config.marker,JSON.stringify({pid:process.pid,provider,commands}));
    return reply(id,{identity:params.identity,capabilities:{interruption:true}});
  }
  if(method==='snapshot')return reply(id,{});
  if(method==='close')return reply(id,{});
  const command=params.command;commands.push(command);
  fs.writeFileSync(provider.config.marker,JSON.stringify({pid:process.pid,provider,commands}));
  if(command.type==='turn.start')throw Error('admission probe must not invoke a model turn');
  if(command.type==='session.open')process.stdout.write(JSON.stringify({schema:'paperclip.harness.v1',sequence:++sequence,
    eventType:'session.started',priority:'p0',payload:{threadId:'extension-thread',sessionId:'extension-session',providerSessionId:'extension-session',
      processId:process.pid,runtimeIdentity:{executionKind:'local_process',processId:process.pid},
      providerDescriptor:{driver:'extension',providerVersion:'1.0.0',effectiveModel:provider.config.wrongModel?'wrong-model':provider.model}}})+'\\n');
  reply(id,{sessionId:'extension-session',providerSessionId:'extension-session',threadId:'extension-thread'});
});`;

describe("plugin environment native harness probes", () => {
  beforeAll(() => {
    execFileSync("cargo", ["build", "--release", "--locked", "--manifest-path", "packages/paperclip-runner/runner/Cargo.toml",
      "-p", "paperclip-runner-core", "--bin", "paperclip-runnerd"], { stdio: "pipe" });
  }, 600_000);

  it.each(["pass", "wrong-release", "missing-version", "wrong-model"])("checks exact admission and cleanup through the task API (%s)", async mode => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "plugin-extension-probe-")));
    const packageRoot = join(root, "package");
    await mkdir(packageRoot);
    const sourceNode = await realpath(process.execPath);
    const command = join(packageRoot, "node");
    await copyFile(sourceNode, command); await chmod(command, 0o500);
    if (process.platform === "darwin") {
      const lib = join(dirname(dirname(sourceNode)), "lib");
      for (const name of await readdir(lib)) if (name.startsWith("libnode.") && name.endsWith(".dylib")) {
        await copyFile(join(lib, name), join(packageRoot, name)); await chmod(join(packageRoot, name), 0o400);
      }
    }
    const entrypoint = join(packageRoot, "runtime.cjs");
    await writeFile(entrypoint, runtime, { mode: 0o400 });
    const release = parseRunnerHarnessReleaseIdentity({ harnessId: "fixture.native/probe", packageName: "@fixture/plugin-native", version: "1.0.0", protocolVersion: 1,
      integrity: `sha256-${Buffer.alloc(32, 1).toString("base64")}`, runtimeDigest: digest(runtime) });
    const resolved: ResolvedRunnerHarness = { pluginId: "plugin", pluginKey: "fixture.native", packageRoot, entrypoint, release,
      declaration: { harnessKey: "probe", displayName: "Fixture harness", configSchema: {}, platforms: ["linux-x64", "darwin-arm64"],
        capabilities: { interruption: true }, runtime: { entrypoint: "runtime.cjs", sha256: digest(runtime) },
        credentials: [{ key: "SYNTHETIC_API_KEY", displayName: "API key", required: true }] } };
    const profile = { schema: "paperclip.harness-launch.v1" as const, identity: mode === "wrong-release" ? { ...release, version: "2.0.0" } : release,
      command: { path: command, sha256: digest(await readFile(command)) }, entrypoint: { path: entrypoint, sha256: digest(runtime) },
      args: [], environmentKeys: ["SYNTHETIC_API_KEY"] };
    const listener = createServer();
    await new Promise<void>(resolveListen => listener.listen(0, "127.0.0.1", resolveListen));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>(resolveClose => listener.close(() => resolveClose()));
    const runnerBinary = resolve("packages/paperclip-runner/runner/target/release/paperclip-runnerd");
    const artifact = readRunnerdArtifactBinding(runnerBinary);
    const workspace = join(root, "workspace");
    const stateDirectory = join(root, "runner-state");
    const operations: PluginEnvironmentTaskOperation[] = [];
    let stopped = false;
    let listenPath = "";
    let handle: RunnerProcessHandle | undefined;
    const task = async (operation: unknown): Promise<PluginEnvironmentTaskResult> => {
      const op = environmentTaskOperationSchema.parse(operation);
      operations.push(op);
      if (op.kind === "describe") return { kind: "description", taskId: "task", launchPreparationVersion: 1, projectAuthCheckVersion: 1,
        ...(mode === "missing-version" ? {} : { harnessExtensionVersion: 1 }), runner: artifact };
      if (op.kind === "prepare") {
        await mkdir(workspace);
        expect(op.requirements).toMatchObject({ provider: "extension", readOnly: true, runtimeContext: null, instructions: "You are a Paperclip agent.",
          settings: { extensionRelease: release, extensionCredentialIdentity: credentialIdentity } });
        return { kind: "prepared", taskId: "task", launch: { configurationId: "prepared", requirementsDigest: runnerLaunchRequirementsDigest(op.requirements as RunnerProviderLaunchRequirements),
          extensionLaunchProfile: profile, provider: createRunnerProviderLaunch(op.requirements as RunnerProviderLaunchRequirements, {
            options: { codexArgs: [], extensionRuntimeRoot: packageRoot }, root, cwd: workspace, codexHome: "", providerNodeCommand: "", opencodeProxyPath: "", acpxSidecarPath: "",
          }) } };
      }
      if (op.kind === "check_project_auth") return { kind: "project_auth", taskId: "task", provider: op.provider, configurationId: op.configurationId, allowed: true };
      if (op.kind === "submit") {
        expect(op).toMatchObject({ runner: { harness: release.harnessId }, credentialIdentity,
          credential: { type: "harness-env", harnessId: release.harnessId, environment: { SYNTHETIC_API_KEY: "selected-key" } },
          launch: { extensionLaunchProfile: profile } });
        expect(op.launch).not.toHaveProperty("environment");
        listenPath = `/api/runner/v1/connect/${op.runner.runId}`;
        handle = spawnRunner({ ...op.launch, runnerBinaryPath: runnerBinary, stateDirectory,
          connection: { mode: "listen", listenAddress: "0.0.0.0", listenPort: port, listenPath }, ticket: op.bootstrapTicket,
          identity: { runnerInstanceId: op.runner.runnerId, environmentLeaseId: op.runner.leaseId, runId: op.runner.runId,
            normalizedSessionId: op.runner.sessionId, turnId: op.runner.turnId, itemId: op.runner.itemId },
          environment: { PAPERCLIP_RUNNER_EXTENSION_PROFILE: JSON.stringify(op.launch!.extensionLaunchProfile),
            ...(op.credential?.type === "harness-env" ? op.credential.environment : {}) },
          processLauncher: (spec: RunnerProcessLaunchSpec) => {
            const child = spawn(spec.command, [...spec.args], { env: spec.environment });
            let stderr = "";
            child.stderr.on("data", value => { stderr += value; });
            return { child, completion: new Promise((resolveChild, reject) => {
              child.once("error", reject);
              child.once("close", (code, signal) => resolveChild({ code, signal, stdout: "", stderr }));
            }) };
          },
        });
        void handle.completion.then(() => { stopped = true; });
        const deadline = Date.now() + 5000;
        await new Promise<void>((resolveConnect, reject) => {
          const connect = () => {
            const socket = createConnection({ host: "127.0.0.1", port });
            socket.once("connect", () => { socket.destroy(); resolveConnect(); });
            socket.once("error", () => { socket.destroy(); if (Date.now() >= deadline) reject(new Error("Fixture Runner did not listen")); else setTimeout(connect, 10); });
          };
          connect();
        });
      } else if (op.kind === "connection") return { kind: "connection", taskId: "task", endpoint: {
        kind: "authenticated_websocket", websocketUrl: `wss://127.0.0.1:${port}${listenPath}`, generation: "fixture", secretHeaders: [],
      } };
      else if (op.kind === "status") return { kind: "status", taskId: "task", phase: stopped ? "completed" : "running", executionStopped: stopped, sessionStateAvailable: stopped };
      else if (op.kind === "stop") handle?.child.kill("SIGTERM");
      else if (op.kind === "read_state") return { kind: "state", taskId: "task", state: JSON.parse(await readFile(join(stateDirectory, "runner-state.json"), "utf8")) };
      else if (op.kind !== "complete") throw new Error(`Unexpected task operation ${op.kind}`);
      return { kind: "accepted", taskId: "task" };
    };
    const context: AdapterEnvironmentTestContext = { companyId: "fixture", adapterType: "paperclip_runner", config: {
      provider: "extension", harnessId: release.harnessId, model: "fixture-model", lifecycleMode: "per_turn",
      extensionConfig: { marker: join(root, "observed.json"), wrongModel: mode === "wrong-model" },
      env: { SYNTHETIC_API_KEY: "selected-key", UNRELATED_SECRET: "must-not-transfer" },
    }, executionTarget: { kind: "remote", transport: "sandbox", remoteCwd: ".", leaseId: "fixture-lease",
      runnerTaskProbe: { runId: "fixture-run", sessionId: "fixture-session" }, runnerTask: task } };
    const actualProbe = nativeRunner.probeNativeRunnerEnvironment;
    let probeFailure: unknown;
    const probe = vi.spyOn(nativeRunner, "probeNativeRunnerEnvironment").mockImplementation(async input => {
      try { return await actualProbe(input); }
      catch (error) { probeFailure = error; throw error; }
    });
    try {
      const result = await probePluginRunnerEnvironment(context, undefined, { resolved, credentialIdentity });
      expect(result.status, `${String(probeFailure)}: ${JSON.stringify(operations)}`).toBe(mode === "pass" ? "pass" : "fail");
      if (mode === "missing-version" || mode === "wrong-release") {
        expect(operations.some(op => op.kind === "submit")).toBe(false);
        expect(operations.some(op => op.kind === "prepare")).toBe(mode === "wrong-release");
        return;
      }
      expect(operations.some(op => op.kind === "submit")).toBe(true);
      expect(operations.some(op => op.kind === "complete")).toBe(true);
      const observed = JSON.parse(await readFile(join(root, "observed.json"), "utf8"));
      expect(observed.provider).toMatchObject({ model: "fixture-model", readOnly: true, runtimeContext: null, instructions: "You are a Paperclip agent." });
      expect(observed.commands.some((entry: { type: string }) => entry.type === "turn.start")).toBe(false);
      expect(JSON.stringify(observed.commands)).not.toContain("paperclip_finish");
      expect(() => process.kill(observed.pid, 0)).toThrow();
      expect(stopped).toBe(true);
    } finally { probe.mockRestore(); handle?.child.kill("SIGTERM"); await handle?.completion; await rm(root, { recursive: true, force: true }); }
  }, 65_000);
});
