import { describe, expect, it, vi } from "vitest";
import { PluginEnvironmentCreationCleanupError } from "@paperclipai/plugin-sdk";
import { acquireDaytonaLeaseWithCleanup } from "../../scripts/agent-commentary-daytona.js";

const scope = { companyId: "company", environmentId: "environment", runId: "run" };
const cleanup = { ...scope, providerLeaseId: "failed-create-attempt", observedProviderLeaseId: "sandbox",
  attemptId: "attempt", accountFingerprint: "a".repeat(64), labels: { "paperclip-run": "run" } };
const failure = () => new PluginEnvironmentCreationCleanupError([new Error("setup timeout")], "cleanup pending", cleanup);

describe("feedback smoke Daytona acquisition cleanup", () => {
  it("destroys a created allocation and preserves the original setup failure", async () => {
    const error = failure();
    const destroy = vi.fn(async () => ({ providerLeaseId: cleanup.providerLeaseId, state: "destroyed" as const }));
    await expect(acquireDaytonaLeaseWithCleanup({ ...scope, acquire: async () => { throw error; }, destroy })).rejects.toBe(error);
    expect(destroy).toHaveBeenCalledExactlyOnceWith(cleanup);
  });

  it("fails when the provider does not acknowledge deletion", async () => {
    await expect(acquireDaytonaLeaseWithCleanup({ ...scope, acquire: async () => { throw failure(); },
      destroy: async () => undefined })).rejects.toThrow("must be cleaned up");
  });

  it("does not destroy an allocation from another company, environment, or run", async () => {
    for (const field of ["companyId", "environmentId", "runId"] as const) {
      const error = new PluginEnvironmentCreationCleanupError([], "foreign scope", { ...cleanup, [field]: "foreign" });
      const destroy = vi.fn();
      await expect(acquireDaytonaLeaseWithCleanup({ ...scope, acquire: async () => { throw error; }, destroy })).rejects.toBe(error);
      expect(destroy).not.toHaveBeenCalled();
    }
  });

  it("does not fabricate cleanup for an ordinary acquisition error", async () => {
    const error = new Error("authentication rejected");
    const destroy = vi.fn();
    await expect(acquireDaytonaLeaseWithCleanup({ ...scope, acquire: async () => { throw error; }, destroy })).rejects.toBe(error);
    expect(destroy).not.toHaveBeenCalled();
  });
});
