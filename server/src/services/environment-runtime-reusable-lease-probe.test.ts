import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveByKey = vi.hoisted(() => vi.fn());
vi.mock("./plugin-environment-driver.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./plugin-environment-driver.js")>(),
  resolvePluginSandboxProviderDriverByKey: resolveByKey,
}));

const { environmentRuntimeService } = await import("./environment-runtime.js");
const { REUSABLE_LEASE_WORKER_METHODS } = await import("./plugin-environment-driver.js");

function workerManager(supportedMethods: readonly string[]) {
  return { getWorker: () => ({ supportedMethods }), isRunning: () => true } as never;
}
const sandbox = (provider: string) => ({ driver: "sandbox" as const, config: { provider } });
const plugin = (driver: Record<string, unknown>) => ({ plugin: { id: "plugin-1", status: "ready" }, driver: { driverKey: "daytona", kind: "sandbox_provider", ...driver } });

// The remote-sandbox warm default asks this before acquisition. It must match
// the acquisition rule, so the default never requests a lease it cannot reuse.
describe("sandbox provider reusable-lease probe", () => {
  beforeEach(() => resolveByKey.mockReset());

  it("reads false for the built-in fake provider, which has no reusable leases", async () => {
    const runtime = environmentRuntimeService({} as never, { pluginWorkerManager: workerManager([]) });
    await expect(runtime.providerSupportsReusableLeases(sandbox("fake"))).resolves.toBe(false);
    expect(resolveByKey).not.toHaveBeenCalled();
  });

  it("reads true only for a running plugin that declares and verifies reusable leases", async () => {
    const verified = environmentRuntimeService({} as never, { pluginWorkerManager: workerManager(REUSABLE_LEASE_WORKER_METHODS) });
    resolveByKey.mockResolvedValue(plugin({ sandboxCapabilities: { reusableLeases: true } }));
    await expect(verified.providerSupportsReusableLeases(sandbox("daytona"))).resolves.toBe(true);
    expect(resolveByKey).toHaveBeenCalledWith(expect.objectContaining({ driverKey: "daytona", requireRunning: true }));

    // A provider that does not declare reusable leases (for example E2B or Modal).
    resolveByKey.mockResolvedValue(plugin({}));
    await expect(verified.providerSupportsReusableLeases(sandbox("e2b"))).resolves.toBe(false);

    // Declared, but the worker does not verify the reuse methods: acquisition would use an ephemeral lease.
    const unverified = environmentRuntimeService({} as never, { pluginWorkerManager: workerManager(["environmentExecute"]) });
    resolveByKey.mockResolvedValue(plugin({ sandboxCapabilities: { reusableLeases: true } }));
    await expect(unverified.providerSupportsReusableLeases(sandbox("daytona"))).resolves.toBe(false);

    // No running worker yet: no default, and no wait for one.
    resolveByKey.mockResolvedValue(null);
    await expect(verified.providerSupportsReusableLeases(sandbox("daytona"))).resolves.toBe(false);
  });

  it("reads false for a non-sandbox environment", async () => {
    const runtime = environmentRuntimeService({} as never, { pluginWorkerManager: workerManager(REUSABLE_LEASE_WORKER_METHODS) });
    await expect(runtime.providerSupportsReusableLeases({ driver: "local", config: {} })).resolves.toBe(false);
  });
});
