import { describe, expect, it } from "vitest";
import type { heartbeatRuns } from "@paperclipai/db";
import { captureEnvironmentAcquisitionDiagnostic } from "../environment-acquisition-diagnostics.js";
import { collectRunFailureDiagnostics } from "../run-failure-diagnostics.js";

type Run = typeof heartbeatRuns.$inferSelect;
const run = (overrides: Partial<Run> = {}) => ({ resultJson: null, ...overrides }) as Run;

describe("run failure diagnostics for a lease acquisition retried as a provider outage", () => {
  it("reports the acquisition phase and provider state for the exact failed run", () => {
    const scope = { companyId: "company-fixture", environmentId: "environment-fixture", runId: "run-fixture" };
    const rpcError = new Error("Daytona lease acquisition timed out; allocation cleanup is pending");
    captureEnvironmentAcquisitionDiagnostic(rpcError, scope,
      { phase: "create", elapsedMs: 90_000, budgetMs: 90_000, providerState: "creating" });
    // The host wraps the RPC error as the transient provider failure, then as the lease failure.
    const unavailable = Object.assign(new Error("Environment provider did not finish starting the sandbox in time.",
      { cause: rpcError }), { code: "environment_provider_unavailable" });
    const failure = Object.assign(new Error("Failed to acquire lease", { cause: unavailable }), { code: "lease_acquire_failed" });
    const fixture = run({ id: scope.runId, companyId: scope.companyId, errorCode: "environment_provider_unavailable" });
    expect(collectRunFailureDiagnostics(fixture, { error: failure, phase: "setup" }).execution).toMatchObject({
      environmentAcquisitionPhase: "create", environmentAcquisitionElapsedMs: 90_000,
      environmentAcquisitionBudgetMs: 90_000, environmentAcquisitionProviderState: "creating",
    });
    expect(collectRunFailureDiagnostics(run({ ...fixture, id: "another-run" }), { error: failure, phase: "setup" }).execution)
      .not.toHaveProperty("environmentAcquisitionPhase");
    expect(collectRunFailureDiagnostics(fixture, { error: failure, phase: "execute" }).execution)
      .not.toHaveProperty("environmentAcquisitionPhase");
  });
});
