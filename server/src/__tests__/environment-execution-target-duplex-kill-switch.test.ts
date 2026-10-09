import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockResolveEnvironmentDriverConfigForRuntime } = vi.hoisted(() => ({
  mockResolveEnvironmentDriverConfigForRuntime: vi.fn(),
}));

vi.mock("../services/environment-config.js", () => ({
  resolveEnvironmentDriverConfigForRuntime: mockResolveEnvironmentDriverConfigForRuntime,
}));

import { resolveEnvironmentExecutionTarget } from "../services/environment-execution-target.js";
import type { EnvironmentRuntimeService } from "../services/environment-runtime.js";

// Build the host sandbox target for one duplex kill-switch state. The fake
// runtime returns the given bridge input, or throws when `rejectRead` is set.
// When `omitMethod` is set the runtime has no `readSandboxDuplexBridgeInput`, so
// the test proves the stamp fails closed on a runtime that predates the read.
async function buildSandboxTarget(input: {
  bridgeInput?: { enableDuplexBridge: boolean };
  rejectRead?: boolean;
  omitMethod?: boolean;
}) {
  mockResolveEnvironmentDriverConfigForRuntime.mockResolvedValue({
    driver: "sandbox",
    config: { provider: "daytona", timeoutMs: 30_000 },
  });

  const readSandboxDuplexBridgeInput = vi.fn(async () => {
    if (input.rejectRead) {
      throw new Error("settings read failed");
    }
    return input.bridgeInput ?? { enableDuplexBridge: false };
  });
  const runtime: Record<string, unknown> = {
    supportsSync: () => false,
    resolveCapabilities: vi.fn(async () => null),
  };
  if (!input.omitMethod) {
    runtime.readSandboxDuplexBridgeInput = readSandboxDuplexBridgeInput;
  }
  const environmentRuntime = runtime as unknown as EnvironmentRuntimeService;

  const target = await resolveEnvironmentExecutionTarget({
    db: {} as never,
    companyId: "company-1",
    adapterType: "codex_local",
    environment: { id: "env-1", driver: "sandbox", config: { provider: "daytona" } },
    leaseId: "lease-1",
    leaseMetadata: { remoteCwd: "/work" },
    lease: { id: "lease-1", leasePolicy: "reuse_by_environment" } as never,
    environmentRuntime,
  });

  if (target?.kind !== "remote" || target.transport !== "sandbox") {
    throw new Error("expected a sandbox target");
  }
  return { target, readSandboxDuplexBridgeInput };
}

describe("resolveEnvironmentExecutionTarget duplex kill switch", () => {
  beforeEach(() => {
    mockResolveEnvironmentDriverConfigForRuntime.mockReset();
  });

  it("stamps the kill switch true when the instance setting is on", async () => {
    const { target, readSandboxDuplexBridgeInput } = await buildSandboxTarget({
      bridgeInput: { enableDuplexBridge: true },
    });
    expect(readSandboxDuplexBridgeInput).toHaveBeenCalledTimes(1);
    expect(target.enableSandboxDuplexBridge).toBe(true);
  });

  it("stamps no grant when the setting is off", async () => {
    const { target } = await buildSandboxTarget({ bridgeInput: { enableDuplexBridge: false } });
    expect(target.enableSandboxDuplexBridge).toBe(false);
  });

  it("stamps no grant when the settings read fails, and the error does not become a grant", async () => {
    const { target, readSandboxDuplexBridgeInput } = await buildSandboxTarget({ rejectRead: true });
    expect(readSandboxDuplexBridgeInput).toHaveBeenCalledTimes(1);
    // The resolve did not throw, and the read error stamped no grant.
    expect(target.enableSandboxDuplexBridge).toBe(false);
  });

  it("stamps no grant when the runtime has no duplex read method", async () => {
    const { target } = await buildSandboxTarget({ omitMethod: true });
    expect(target.enableSandboxDuplexBridge).toBe(false);
  });
});
