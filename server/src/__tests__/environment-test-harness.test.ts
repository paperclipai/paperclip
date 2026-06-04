import { describe, expect, it } from "vitest";
import {
  createEnvironmentTestHarness,
  createFakeEnvironmentDriver,
  filterEnvironmentEvents,
  assertEnvironmentEventOrder,
  assertLeaseLifecycle,
  assertWorkspaceRealizationLifecycle,
  assertExecutionLifecycle,
  assertEnvironmentError,
} from "@paperclipai/plugin-sdk/testing";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

const FAKE_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test-env-plugin",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Test Environment Plugin",
  description: "Test fixture",
  author: "test",
  categories: ["connector"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./worker.js" },
  environmentDrivers: [{ driverKey: "fake", displayName: "Fake Driver" }],
};

const BASE_PARAMS = {
  driverKey: "fake",
  companyId: "co-1",
  environmentId: "env-1",
  config: {},
};

describe("environment test harness", () => {
  it("records lifecycle events through a full acquire → realize → execute → release cycle", async () => {
    const driver = createFakeEnvironmentDriver();
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    const lease = await harness.acquireLease({ ...BASE_PARAMS, runId: "run-1" });
    expect(lease.providerLeaseId).toBe("fake-lease-1");

    await harness.realizeWorkspace({
      ...BASE_PARAMS,
      lease,
      workspace: { localPath: "/tmp/test" },
    });

    const execResult = await harness.execute({
      ...BASE_PARAMS,
      lease,
      command: "echo",
      args: ["hello"],
    });
    expect(execResult.exitCode).toBe(0);
    expect(execResult.stdout).toContain("echo hello");

    await harness.releaseLease({
      ...BASE_PARAMS,
      providerLeaseId: lease.providerLeaseId,
    });

    expect(harness.environmentEvents).toHaveLength(4);
    assertEnvironmentEventOrder(harness.environmentEvents, [
      "acquireLease",
      "realizeWorkspace",
      "execute",
      "releaseLease",
    ]);
  });

  it("records validateConfig and probe events", async () => {
    const driver = createFakeEnvironmentDriver();
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    const validation = await harness.validateConfig({
      driverKey: "fake",
      config: { host: "test" },
    });
    expect(validation.ok).toBe(true);

    const probe = await harness.probe(BASE_PARAMS);
    expect(probe.ok).toBe(true);

    expect(filterEnvironmentEvents(harness.environmentEvents, "validateConfig")).toHaveLength(1);
    expect(filterEnvironmentEvents(harness.environmentEvents, "probe")).toHaveLength(1);
  });

  it("supports probe failure injection", async () => {
    const driver = createFakeEnvironmentDriver({ probeFailure: true });
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    const probe = await harness.probe(BASE_PARAMS);
    expect(probe.ok).toBe(false);
  });

  it("supports acquire failure injection and records errors", async () => {
    const driver = createFakeEnvironmentDriver({ acquireFailure: "No capacity" });
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    await expect(harness.acquireLease({ ...BASE_PARAMS, runId: "run-1" })).rejects.toThrow("No capacity");
    const errorEvent = assertEnvironmentError(harness.environmentEvents, "acquireLease");
    expect(errorEvent.error).toBe("No capacity");
  });

  it("supports execute failure injection", async () => {
    const driver = createFakeEnvironmentDriver({ executeFailure: true });
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    const lease = await harness.acquireLease({ ...BASE_PARAMS, runId: "run-1" });
    const result = await harness.execute({
      ...BASE_PARAMS,
      lease,
      command: "failing-cmd",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Simulated execution failure");
  });

  it("supports lease resume", async () => {
    const driver = createFakeEnvironmentDriver();
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    const lease = await harness.acquireLease({ ...BASE_PARAMS, runId: "run-1" });
    const resumed = await harness.resumeLease({
      ...BASE_PARAMS,
      providerLeaseId: lease.providerLeaseId!,
    });
    expect(resumed.metadata).toHaveProperty("resumed", true);
  });

  it("resume throws for unknown lease", async () => {
    const driver = createFakeEnvironmentDriver();
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    await expect(
      harness.resumeLease({ ...BASE_PARAMS, providerLeaseId: "nonexistent" }),
    ).rejects.toThrow("not found");
  });

  it("supports destroyLease", async () => {
    const driver = createFakeEnvironmentDriver();
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    const lease = await harness.acquireLease({ ...BASE_PARAMS, runId: "run-1" });
    await harness.destroyLease({
      ...BASE_PARAMS,
      providerLeaseId: lease.providerLeaseId,
    });

    assertLeaseLifecycle(harness.environmentEvents, "env-1");
  });

  it("assertLeaseLifecycle throws when acquire is missing", () => {
    expect(() => assertLeaseLifecycle([], "env-1")).toThrow("No acquireLease event");
  });

  it("assertWorkspaceRealizationLifecycle validates workspace between acquire and release", async () => {
    const driver = createFakeEnvironmentDriver();
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    const lease = await harness.acquireLease({ ...BASE_PARAMS, runId: "run-1" });
    await harness.realizeWorkspace({
      ...BASE_PARAMS,
      lease,
      workspace: { localPath: "/tmp/ws" },
    });
    await harness.releaseLease({ ...BASE_PARAMS, providerLeaseId: lease.providerLeaseId });

    const realize = assertWorkspaceRealizationLifecycle(harness.environmentEvents, "env-1");
    expect(realize.type).toBe("realizeWorkspace");
  });

  it("assertExecutionLifecycle validates execute within lease bounds", async () => {
    const driver = createFakeEnvironmentDriver();
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: driver,
    });

    const lease = await harness.acquireLease({ ...BASE_PARAMS, runId: "run-1" });
    await harness.execute({ ...BASE_PARAMS, lease, command: "ls" });
    await harness.execute({ ...BASE_PARAMS, lease, command: "pwd" });
    await harness.releaseLease({ ...BASE_PARAMS, providerLeaseId: lease.providerLeaseId });

    const execs = assertExecutionLifecycle(harness.environmentEvents, "env-1");
    expect(execs).toHaveLength(2);
  });

  it("throws when driver does not implement a required hook", async () => {
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      environmentDriver: { driverKey: "bare" },
    });

    await expect(harness.probe(BASE_PARAMS)).rejects.toThrow("does not implement onProbe");
    assertEnvironmentError(harness.environmentEvents, "probe");
  });

  it("base harness methods remain functional", async () => {
    const driver = createFakeEnvironmentDriver();
    const harness = createEnvironmentTestHarness({
      manifest: FAKE_MANIFEST,
      capabilities: [...FAKE_MANIFEST.capabilities, "events.subscribe", "plugin.state.read", "plugin.state.write"],
      environmentDriver: driver,
    });

    harness.ctx.logger.info("test");
    expect(harness.logs).toHaveLength(1);
  });
});
