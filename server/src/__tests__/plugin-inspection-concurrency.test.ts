import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

it("bounds actual provider reads across caller timeouts, plugins, retries, and worker exit", async () => {
  const baseline = idleWorkSnapshot().active;
  const manager = createPluginWorkerManager();
  const manifest: PaperclipPluginManifestV1 = { id: "fixture.inspect", apiVersion: 1, version: "1.0.0",
    displayName: "Inspection fixture", categories: ["automation"], capabilities: [], entrypoints: { worker: "worker.cjs" } };
  const params = { driverKey: "fixture", companyId: "fixture-company", environmentId: "fixture-environment",
    config: {}, providerLeaseId: "fixture-resource", leaseMetadata: { holdInspection: true } };
  try {
    for (const pluginId of ["fixture.inspect.a", "fixture.inspect.b"]) await manager.startWorker(pluginId, {
      entrypointPath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/plugin-worker-delayed.cjs"),
      manifest, config: {}, instanceInfo: { instanceId: "fixture-instance", hostVersion: "1.0.0" }, apiVersion: 1, hostHandlers: {},
    });
    await Promise.all(["fixture.inspect.a", "fixture.inspect.b"].map(pluginId =>
      expect(manager.call(pluginId, "environmentInspectLease", params, 20)).rejects.toThrow("timed out")));
    expect(idleWorkSnapshot().active).toBe(baseline + 2);
    for (let retry = 0; retry < 4; retry++) await expect(manager.call("fixture.inspect.a", "environmentInspectLease", params, 20)).rejects.toThrow("concurrency limit");
    for (const pluginId of ["fixture.inspect.a", "fixture.inspect.b"]) expect(await manager.call(pluginId, "health", {})).toMatchObject({
      details: { inspectionCount: 1, activeInspections: 1 },
    });
    await manager.call("fixture.inspect.a", "configChanged", { companyId: "fixture-company", config: { releaseInspections: true } });
    expect(idleWorkSnapshot().active).toBe(baseline + 1);
    await expect(manager.call("fixture.inspect.a", "environmentInspectLease", params, 20)).rejects.toThrow("timed out");
    await expect(manager.call("fixture.inspect.b", "environmentInspectLease", params, 20)).rejects.toThrow("concurrency limit");
    await manager.stopWorker("fixture.inspect.b");
    expect(idleWorkSnapshot().active).toBe(baseline + 1);
    await expect(manager.call("fixture.inspect.a", "environmentInspectLease", { ...params, leaseMetadata: {} }, 1000)).resolves.toEqual({
      providerLeaseId: "fixture-resource", state: "destroyed",
    });
  } finally { await manager.stopAll(); }
  expect(idleWorkSnapshot().active).toBe(baseline);
}, 15_000);
