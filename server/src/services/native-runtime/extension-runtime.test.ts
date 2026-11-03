import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { PluginRecord } from "@paperclipai/shared";
import type { AdapterEnvironmentTestContext } from "@paperclipai/adapter-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { createRunnerHarnessRegistry } from "../runner-harness-registry.js";
import { prepareInstalledRunnerHarness, probeInstalledRunnerHarness } from "./extension-runtime.js";
import { NativeEnvironmentProbeCleanupError } from "../../vendor/paperclip-runner/index.js";

const state = vi.hoisted(() => ({ registry: null as unknown as ReturnType<typeof createRunnerHarnessRegistry>, runtimeRoot: "", remoteProbe: vi.fn() }));
vi.mock("../runner-harness-registry.js", async () => ({
  ...await vi.importActual("../runner-harness-registry.js"),
  runnerHarnessRegistry: () => state.registry,
}));
vi.mock("../../home-paths.js", () => ({ resolvePaperclipInstanceRoot: () => state.runtimeRoot }));
vi.mock("./plugin-runner-probe.js", () => ({ probePluginRunnerEnvironment: state.remoteProbe }));
vi.mock("./native-session-executor.js", () => ({ stageRemoteRunnerDirectory: async (input: { sourcePath: string; targetPath: string }) => {
  await cp(input.sourcePath, input.targetPath, { recursive: true });
} }));

const roots: string[] = [];
const database = {} as Db;
const secret = "synthetic-selected-credential";
// This is an independently loaded package, with only Node's standard library.
// It checks its received native probe context before reporting model admission.
const runtime = `import { createInterface } from 'node:readline';
import { writeFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
let provider;
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === 'initialize') {
    provider = request.params.provider;
    if (request.params.probe !== true || provider.toolsDenied !== true || provider.readOnly !== true
      || provider.instructions !== '' || provider.runtimeContext !== null
      || Object.hasOwn(provider, 'tools') || process.env.LEAK_THIS || !process.env.SYNTHETIC_API_KEY) {
      throw new Error('unsafe native probe');
    }
    if (provider.config.reject) {
      process.stdout.write(JSON.stringify({ schema: request.schema, id: request.id, ok: false,
        error: { code: 'auth_failed', message: process.env.SYNTHETIC_API_KEY, retryable: false } }) + '\\n');
      continue;
    }
    if (provider.config.descendant) {
      spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});require("node:fs").writeFileSync('+JSON.stringify(provider.config.descendant)+',String(process.pid));setInterval(()=>{},1000)'],
        { stdio: 'ignore', env: process.env });
      while (true) { try { await access(provider.config.descendant); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    }
    await writeFile(provider.config.marker, JSON.stringify({ pid: process.pid, model: provider.model,
      toolsDenied: provider.toolsDenied, credentialNames: Object.keys(process.env) }));
    result = { identity: request.params.identity, capabilities: { interruption: true }, probePassed: true,
      effectiveModel: provider.config.wrongModel ? 'different-native-model' : provider.model };
  }
  if (request.method === 'close') {
    await writeFile(provider.config.marker + '.closed', 'native scope disposed');
    if (provider.config.descendant) {
      process.stdout.write(JSON.stringify({schema:request.schema,id:request.id,ok:true,result:{}})+'\\n',()=>process.exit(0));
      continue;
    }
  }
  process.stdout.write(JSON.stringify({ schema: request.schema, id: request.id, ok: true, result }) + '\\n');
}
`;

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "paperclip-extension-probe-")));
  roots.push(root);
  const packageRoot = path.join(root, "package");
  await mkdir(packageRoot);
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@example/plugin-native-harness", version: "1.0.0", type: "module" }));
  await writeFile(path.join(packageRoot, "runtime.js"), runtime);
  state.runtimeRoot = path.join(root, "instance");
  const now = new Date(0);
  const plugin: PluginRecord = {
    id: "synthetic-plugin", pluginKey: "example.native", packageName: "@example/plugin-native-harness", version: "1.0.0",
    apiVersion: 1, categories: ["automation"], status: "ready", installOrder: 1, packagePath: packageRoot,
    lastError: null, installedAt: now, updatedAt: now,
    manifestJson: { id: "example.native", apiVersion: 1, version: "1.0.0", displayName: "Native harness", description: "Synthetic native harness",
      author: "Tests", categories: ["automation"], capabilities: ["runner.harnesses.register"], entrypoints: { worker: "worker.js" },
      runnerHarnesses: [{ harnessKey: "synthetic", displayName: "Synthetic native harness",
        configSchema: { type: "object", properties: { marker: { type: "string" }, wrongModel: { type: "boolean" }, reject: { type: "boolean" }, descendant: { type: "string" } }, required: ["marker"], additionalProperties: false },
        platforms: ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"], capabilities: { interruption: true },
        runtime: { entrypoint: "runtime.js", sha256: `sha256:${createHash("sha256").update(runtime).digest("hex")}` },
        credentials: [{ key: "SYNTHETIC_API_KEY", displayName: "Synthetic API key", required: true }],
      }],
    },
  };
  state.registry = createRunnerHarnessRegistry(async companyId => [{ plugin, enabled: companyId === "company-1" }]);
  const context: AdapterEnvironmentTestContext = { companyId: "company-1", adapterType: "paperclip_runner", config: {
    provider: "extension", harnessId: "example.native/synthetic", model: "caller-selected-model",
    extensionConfig: { marker: path.join(root, "probe.json") }, env: { SYNTHETIC_API_KEY: secret },
  } };
  return { root, packageRoot, plugin, context };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("installed native harness probes", () => {
  it("can repeat setup against an already staged read-only Node runtime closure", async () => {
    const { root, context } = await fixture();
    expect((await probeInstalledRunnerHarness(database, context)).status).toBe("pass");
    const first = JSON.parse(await readFile(path.join(root, "probe.json"), "utf8"));
    expect((await probeInstalledRunnerHarness(database, context)).status).toBe("pass");
    const second = JSON.parse(await readFile(path.join(root, "probe.json"), "utf8"));
    expect(second.pid).not.toBe(first.pid);
    expect(() => process.kill(second.pid, 0)).toThrow();
  });

  it("runs an independent package with the exact model and scoped credentials, then proves cleanup", async () => {
    const { root, context } = await fixture();
    vi.stubEnv("LEAK_THIS", "must-not-reach-harness");
    const result = await probeInstalledRunnerHarness(database, context);
    expect(result).toMatchObject({ status: "pass", checks: [{ code: "runner_extension_probe_passed" }] });
    const observed = JSON.parse(await readFile(path.join(root, "probe.json"), "utf8"));
    expect(observed).toMatchObject({ model: "caller-selected-model", toolsDenied: true });
    // macOS may synthesize this encoding value after exec; it is not inherited
    // controller configuration or a provider credential.
    expect(observed.credentialNames.filter((name: string) => name !== "__CF_USER_TEXT_ENCODING")).toEqual(["SYNTHETIC_API_KEY"]);
    expect(await readFile(path.join(root, "probe.json.closed"), "utf8")).toBe("native scope disposed");
    expect(() => process.kill(observed.pid, 0)).toThrow();
  });

  it("refuses a different native model and still stops the owned runtime", async () => {
    const { root, context } = await fixture();
    (context.config.extensionConfig as Record<string, unknown>).wrongModel = true;
    expect(await probeInstalledRunnerHarness(database, context)).toMatchObject({ status: "fail", checks: [{ code: "runner_extension_probe_failed" }] });
    const observed = JSON.parse(await readFile(path.join(root, "probe.json"), "utf8"));
    expect(() => process.kill(observed.pid, 0)).toThrow();
  });

  it("keeps provider authentication errors and credentials out of public check results", async () => {
    const { context } = await fixture();
    (context.config.extensionConfig as Record<string, unknown>).reject = true;
    const result = await probeInstalledRunnerHarness(database, context);
    expect(result.status).toBe("fail");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("rejects a missing credential and unsupported remote targets before starting a provider", async () => {
    const { root, context } = await fixture();
    expect(await probeInstalledRunnerHarness(database, { ...context, config: { ...context.config, env: {} } })).toMatchObject({ status: "fail" });
    await expect(readFile(path.join(root, "probe.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const result = await probeInstalledRunnerHarness(database, { ...context, executionTarget: { kind: "remote" } as AdapterEnvironmentTestContext["executionTarget"] });
    expect(result).toMatchObject({ status: "fail", checks: [{ code: "runner_extension_probe_failed" }] });
    await expect(readFile(path.join(root, "probe.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to prepare a changed closure under an already admitted release", async () => {
    const { packageRoot } = await fixture();
    const admitted = await state.registry.resolve("company-1", "example.native/synthetic");
    await writeFile(path.join(packageRoot, "late-asset.json"), "{}");
    await expect(prepareInstalledRunnerHarness(database, { companyId: "company-1", environment: { SYNTHETIC_API_KEY: secret },
      provider: { harnessId: admitted.release.harnessId, release: admitted.release, config: { marker: "unused" } },
    })).rejects.toThrow("runner_extension_release_changed");
  });

  it("preserves the remote probe cleanup owner until physical retirement is proven", async () => {
    const { context } = await fixture();
    const retirement = new Promise<void>(() => {});
    const cleanup = new NativeEnvironmentProbeCleanupError(retirement, new Error("Fixture cleanup is still pending"), [], async () => {});
    state.remoteProbe.mockRejectedValueOnce(cleanup);
    await expect(probeInstalledRunnerHarness(database, { ...context, executionTarget: {
      kind: "remote", transport: "sandbox", remoteCwd: ".", leaseId: "fixture-lease", runnerTask: async () => ({}),
      runnerTaskProbe: { runId: "fixture-run", sessionId: "fixture-session" },
    } })).rejects.toBe(cleanup);
    expect(state.remoteProbe).toHaveBeenCalledWith(expect.objectContaining({ companyId: "company-1" }), undefined,
      expect.objectContaining({ resolved: expect.objectContaining({ release: expect.objectContaining({ harnessId: "example.native/synthetic" }) }),
        credentialIdentity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) }));
  });

  it.each(["local", "remote", "lost-remote-wrapper", "unconfirmed-remote-proof"])("reaps a descendant that ignores TERM after its harness leader exits (%s)", async mode => {
    const { root, context } = await fixture();
    const descendant = path.join(root, "descendant.pid");
    (context.config.extensionConfig as Record<string, unknown>).descendant = descendant;
    let denyRetirementProof = mode === "unconfirmed-remote-proof";
    const runner: CommandManagedRuntimeRunner = { execute: input => new Promise((resolveResult, reject) => {
      if (denyRetirementProof && input.args?.[1]?.includes("Harness process retirement remains unconfirmed")) {
        resolveResult({ exitCode: null, signal: null, timedOut: true, stdout: "", stderr: "Synthetic cleanup transport outage", pid: null, startedAt: null });
        return;
      }
      const child = spawn(input.command, input.args ?? [], { cwd: input.cwd, env: { ...process.env, ...input.env } });
      let stdout = "", stderr = "", timedOut = false;
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, input.timeoutMs ?? 10_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", (exitCode, signal) => { clearTimeout(timer); resolveResult({ exitCode, signal, timedOut, stdout, stderr, pid: child.pid ?? null, startedAt: null }); });
      if (mode === "lost-remote-wrapper" && input.args?.[0] === "-e" && input.args[2]?.includes('"recordPath"')) {
        // Kill the execution wrapper after the harness owns a live descendant.
        // A later command must recover its recorded group and prove absence.
        void (async () => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            try { await readFile(descendant); await readFile(path.join(root, "probe.json")); child.kill("SIGKILL"); return; }
            catch { await new Promise(resolveWait => setTimeout(resolveWait, 10)); }
          }
        })();
      }
    }) };
    if (mode !== "local") {
      context.executionTarget = { kind: "remote", transport: "sandbox", remoteCwd: root, runner };
    }
    let pid: number | undefined;
    try {
      let result: Awaited<ReturnType<typeof probeInstalledRunnerHarness>> | undefined;
      let cleanupFailure: unknown;
      try { result = await probeInstalledRunnerHarness(database, context); }
      catch (error) { cleanupFailure = error; }
      pid = Number(await readFile(descendant, "utf8"));
      const observed = JSON.parse(await readFile(path.join(root, "probe.json"), "utf8"));
      expect(() => process.kill(observed.pid, 0)).toThrow();
      expect(() => process.kill(pid!, 0)).toThrow();
      if (mode === "unconfirmed-remote-proof") {
        expect(cleanupFailure).toBeInstanceOf(NativeEnvironmentProbeCleanupError);
        if (!(cleanupFailure instanceof NativeEnvironmentProbeCleanupError)) throw cleanupFailure;
        await expect(cleanupFailure.retired).rejects.toThrow("retirement remains unconfirmed");
        expect(await readdir(path.join(root, ".paperclip-runtime", "harness-probes"))).not.toEqual([]);
        denyRetirementProof = false;
        await cleanupFailure.retryCleanup!();
      } else {
        expect(cleanupFailure).toBeUndefined();
        expect(result?.status).toBe(mode === "lost-remote-wrapper" ? "fail" : "pass");
      }
      if (mode !== "local") expect(await readdir(path.join(root, ".paperclip-runtime", "harness-probes"))).toEqual([]);
    } finally {
      pid ??= await readFile(descendant, "utf8").then(Number).catch(() => undefined);
      if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* Already retired by the production helper. */ }
    }
  }, 25_000);
});
