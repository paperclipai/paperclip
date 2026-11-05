import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const providerRoot = path.join(repoRoot, "packages/plugins/sandbox-providers/daytona");
const pluginId = "fixture-daytona-provider";

it.each(["release", "cancel", "stop", "destroy", "resume", "stalled-close"] as const)("preserves worker ownership after %s of a bound duplex channel", async mode => {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-daytona-worker-close-"));
  const journal = path.join(root, "provider.jsonl"), savedFile = path.join(root, "saved.txt");
  const workerFile = path.join(root, "worker.mjs");
  const manager = createPluginWorkerManager();
  try {
    await writeFile(savedFile, "saved work remains intact", { mode: 0o600 });
    await build({
      entryPoints: { worker: path.join(providerRoot, "src/worker.ts"), manifest: path.join(providerRoot, "src/manifest.ts") },
      outdir: root,
      outExtension: { ".js": ".mjs" },
      platform: "node",
      format: "esm",
      target: "node24",
      bundle: true,
      logLevel: "silent",
      nodePaths: [path.join(repoRoot, "server/node_modules")],
      alias: {
        "@daytonaio/sdk": path.join(repoRoot, "server/src/__tests__/fixtures/daytona-worker-lifecycle-sdk.mjs"),
        "@paperclipai/plugin-sdk": path.join(repoRoot, "packages/plugins/sdk/dist/index.js"),
      },
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    });
    const { default: manifest } = await import(pathToFileURL(path.join(root, "manifest.mjs")).href);
    const worker = await manager.startWorker(pluginId, {
      entrypointPath: workerFile,
      manifest,
      config: {},
      instanceInfo: { instanceId: "fixture-instance", hostVersion: "0.0.0" },
      apiVersion: 1,
      hostHandlers: {},
      env: { PAPERCLIP_DAYTONA_FIXTURE_JOURNAL: journal, PAPERCLIP_DAYTONA_FIXTURE_SAVED_FILE: savedFile,
        PAPERCLIP_DAYTONA_FIXTURE_HANG_CLOSE: mode === "stalled-close" ? "1" : "0" },
      duplexChannelLimits: { closeTimeoutMs: 500 },
    });
    const pid = worker.diagnostics().pid;
    const exited = new Promise<void>(resolve => worker.on("exit", () => resolve()));
    const base = { driverKey: "daytona", companyId: "fixture-company", environmentId: "fixture-environment",
      config: { apiKey: "fixture-not-a-credential", image: "fixture-image", timeoutMs: 2_000, livenessTimeoutMs: 250, reuseLease: true } };
    const acquisition = { ...base, agentId: "fixture-agent", executionWorkspaceId: "fixture-workspace" };
    const first = await manager.call(pluginId, "environmentAcquireLease", { ...acquisition, runId: "fixture-first-run" });
    const next = await manager.call(pluginId, "environmentAcquireLease", { ...acquisition, runId: "fixture-next-run" });
    const channel = await worker.openDuplexChannel({
      driverKey: base.driverKey, companyId: base.companyId, environmentId: base.environmentId,
      providerLeaseId: first.providerLeaseId!, command: ["fixture-bridge"],
    });
    const teardown = { ...base, providerLeaseId: first.providerLeaseId! };
    if (mode === "resume") {
      await manager.call(pluginId, "environmentExecute", { ...base, lease: first,
        command: "fixture-provider-stop", bypassSession: true });
      await expect(manager.call(pluginId, "environmentResumeLease", { ...teardown, leaseMetadata: first.metadata }))
        .resolves.toMatchObject({ providerLeaseId: first.providerLeaseId, metadata: { resumedFromState: "stopped" } });
    } else if (mode === "stop") await manager.call(pluginId, "environmentStopLease", teardown);
    else if (mode === "destroy") await manager.call(pluginId, "environmentDestroyLease", teardown);
    else await manager.call(pluginId, "environmentReleaseLease", { ...teardown, cancelActiveWork: mode === "cancel" });
    await channel.close();
    if (mode === "stalled-close") await exited;
    else await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 100))]);
    const execution = manager.call(pluginId, "environmentExecute", {
      ...base, lease: next, command: "printf", args: ["monitor-after-release"], bypassSession: true,
    });
    if (mode === "stalled-close") await expect(execution).rejects.toThrow("is stopped");
    else await expect(execution).resolves.toMatchObject({ exitCode: 0, stdout: "saved work remains intact" });
    expect(worker.status).toBe(mode === "stalled-close" ? "stopped" : "running");
    expect(manager.getWorker(pluginId)).toBe(worker);
    expect(worker.diagnostics().pid).toBe(mode === "stalled-close" ? null : pid);
    channel.write(new TextEncoder().encode("closed channel must remain closed"));
    channel.kill();
    if (mode !== "resume") await expect(manager.call(pluginId, "environmentExecute", {
      ...base, lease: first, command: "printf", args: ["closed-lease-after-release"], bypassSession: true,
    })).rejects.toThrow();
    const events = (await readFile(journal, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(events.filter(event => event.event === "create")).toHaveLength(2);
    expect(events.filter(event => event.event === "pty.open")).toHaveLength(1);
    expect(events.filter(event => event.event === "pty.write")).toHaveLength(1);
    expect(events.filter(event => event.event === "pty.kill")).toHaveLength(1);
    expect(events.filter(event => event.event === "pty.disconnect")).toHaveLength(1);
    expect(events.filter(event => event.event === "execute" && event.afterRelease))
      .toEqual(mode === "stalled-close" ? [] : [{ event: "execute", id: next.providerLeaseId, afterRelease: true }]);
    expect(await readFile(savedFile, "utf8")).toBe("saved work remains intact");
  } finally {
    await manager.stopAll();
    await rm(root, { recursive: true, force: true });
  }
});
