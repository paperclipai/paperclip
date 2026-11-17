import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JsonRpcCallError, readEnvironmentAcquisitionDiagnostic, readEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import type { heartbeatRuns } from "@paperclipai/db";
import { createPluginWorkerHandle } from "../services/plugin-worker-manager.js";
import { captureEnvironmentAcquisitionDiagnostic } from "../services/environment-acquisition-diagnostics.js";
import { collectRunFailureDiagnostics } from "../services/run-failure-diagnostics.js";

describe("acquisition diagnostics through the built worker and real host client", () => {
  it("keeps concurrent RPC errors isolated through wrapping and failure projection", async () => {
    const handle = createPluginWorkerHandle("test.acquisition", {
      entrypointPath: fileURLToPath(new URL("./fixtures/plugin-worker-acquisition-diagnostic.mjs", import.meta.url)),
      manifest: { id: "test.acquisition", apiVersion: 1, version: "1.0.0", displayName: "Acquisition fixture",
        description: "Acquisition fixture", author: "Paperclip", categories: ["automation"], capabilities: [],
        entrypoints: { worker: "fixture.mjs" } },
      config: {}, instanceInfo: { instanceId: "instance-fixture", hostVersion: "1.0.0" }, apiVersion: 1,
      hostHandlers: {}, rpcTimeoutMs: 5_000,
      execArgv: ["--import", createRequire(import.meta.url).resolve("tsx")],
    });
    try {
      await handle.start();
      const first = { driverKey: "daytona", companyId: "company-fixture", environmentId: "environment-fixture",
        runId: "run-first", config: { phase: "create" } };
      const second = { ...first, runId: "run-second", config: { phase: "shell" } };
      const [a, b] = await Promise.all([first, second].map(params => handle.call("environmentAcquireLease", params).catch(error => error)));
      expect(a).toBeInstanceOf(JsonRpcCallError);
      expect(b).toBeInstanceOf(JsonRpcCallError);
      expect(a).not.toBe(b);
      for (const [error, params] of [[a, first], [b, second]] as const) {
        expect(error.code).toBe(-32002);
        expect(readEnvironmentCreationCleanupError(error)?.runId).toBe(params.runId);
        expect(error.message).toBe("Daytona lease acquisition timed out; allocation cleanup is pending");
        expect(JSON.stringify(error)).not.toContain("private-provider-");
        const diagnostic = readEnvironmentAcquisitionDiagnostic(error);
        expect(diagnostic).toEqual({ phase: params.config.phase, elapsedMs: 2_000, budgetMs: 2_000 });
        const properties = Object.getOwnPropertyDescriptors(error);
        Object.freeze(error);
        captureEnvironmentAcquisitionDiagnostic(error, params, diagnostic);
        const run = { id: params.runId, companyId: params.companyId, errorCode: "setup_failed", resultJson: null } as typeof heartbeatRuns.$inferSelect;
        const diagnostics = collectRunFailureDiagnostics(run, { error: new Error("Cleanup confirmed", { cause: error }), phase: "setup" });
        expect(diagnostics.execution).toMatchObject({ environmentAcquisitionPhase: params.config.phase,
          environmentAcquisitionElapsedMs: 2_000, environmentAcquisitionBudgetMs: 2_000 });
        expect(JSON.stringify(diagnostics)).not.toContain("private-provider-");
        // Object.freeze changes descriptor flags but no error values or identity.
        for (const [key, descriptor] of Object.entries(properties)) expect(Object.getOwnPropertyDescriptor(error, key)?.value).toBe(descriptor.value);
        expect(collectRunFailureDiagnostics({ ...run, id: "another-run" }, { error, phase: "setup" }).execution)
          .not.toHaveProperty("environmentAcquisitionPhase");
      }
      const destroyed = await handle.call("environmentDestroyLease", { ...first, providerLeaseId: "fixture" }).catch(error => error);
      expect(destroyed).toBeInstanceOf(JsonRpcCallError);
      expect(readEnvironmentCreationCleanupError(destroyed)).not.toBeNull();
      expect(readEnvironmentAcquisitionDiagnostic(destroyed)).toBeNull();
    } finally { await handle.stop(); }
  });
});
