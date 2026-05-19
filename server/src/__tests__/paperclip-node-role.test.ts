// Tests for the PAPERCLIP_NODE_ROLE config field that drives the HA
// API/worker split. Verifies env parsing + the implicit override that
// forces heartbeatSchedulerEnabled=false on the API tier.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../config.js";
import { createApiTierPluginWorkerManagerStub } from "../services/plugin-worker-manager-stub.js";

describe("PAPERCLIP_NODE_ROLE", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear role-related env between tests
    delete process.env.PAPERCLIP_NODE_ROLE;
    delete process.env.HEARTBEAT_SCHEDULER_ENABLED;
    // Required by loadConfig() — feed deterministic values that satisfy
    // bind validation (local_trusted requires loopback bind; authenticated
    // accepts the default 0.0.0.0).
    process.env.PAPERCLIP_PUBLIC_URL = "http://localhost:3100";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to 'all' when env is unset (single-pod / backwards-compat)", () => {
    const config = loadConfig();
    expect(config.paperclipNodeRole).toBe("all");
  });

  it("accepts 'api'", () => {
    process.env.PAPERCLIP_NODE_ROLE = "api";
    const config = loadConfig();
    expect(config.paperclipNodeRole).toBe("api");
  });

  it("accepts 'worker'", () => {
    process.env.PAPERCLIP_NODE_ROLE = "worker";
    const config = loadConfig();
    expect(config.paperclipNodeRole).toBe("worker");
  });

  it("falls back to 'all' on unknown values (safe default)", () => {
    process.env.PAPERCLIP_NODE_ROLE = "frontend";
    const config = loadConfig();
    expect(config.paperclipNodeRole).toBe("all");
  });

  it("forces heartbeatSchedulerEnabled=false when role=api regardless of HEARTBEAT_SCHEDULER_ENABLED", () => {
    process.env.PAPERCLIP_NODE_ROLE = "api";
    process.env.HEARTBEAT_SCHEDULER_ENABLED = "true";
    const config = loadConfig();
    expect(config.heartbeatSchedulerEnabled).toBe(false);
  });

  it("respects HEARTBEAT_SCHEDULER_ENABLED when role=worker", () => {
    process.env.PAPERCLIP_NODE_ROLE = "worker";
    process.env.HEARTBEAT_SCHEDULER_ENABLED = "false";
    const config = loadConfig();
    expect(config.heartbeatSchedulerEnabled).toBe(false);

    process.env.HEARTBEAT_SCHEDULER_ENABLED = "true";
    const config2 = loadConfig();
    expect(config2.heartbeatSchedulerEnabled).toBe(true);
  });

  it("respects HEARTBEAT_SCHEDULER_ENABLED when role=all (default)", () => {
    process.env.HEARTBEAT_SCHEDULER_ENABLED = "false";
    const config = loadConfig();
    expect(config.heartbeatSchedulerEnabled).toBe(false);
  });
});

describe("PAPERCLIP_WORKERS_INTERNAL_URL", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.PAPERCLIP_WORKERS_INTERNAL_URL;
    process.env.PAPERCLIP_PUBLIC_URL = "http://localhost:3100";
    process.env.PAPERCLIP_DEPLOYMENT_MODE = "authenticated";
    process.env.PAPERCLIP_DEPLOYMENT_EXPOSURE = "private";
    process.env.PAPERCLIP_AUTH_BASE_URL_MODE = "explicit";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("defaults to null when unset", () => {
    expect(loadConfig().paperclipWorkersInternalUrl).toBeNull();
  });

  it("parses the worker tier URL and strips trailing slashes", () => {
    process.env.PAPERCLIP_WORKERS_INTERNAL_URL = "http://paperclip-workers:3100/";
    expect(loadConfig().paperclipWorkersInternalUrl).toBe("http://paperclip-workers:3100");
  });

  it("treats an empty/whitespace value as unset", () => {
    process.env.PAPERCLIP_WORKERS_INTERNAL_URL = "   ";
    expect(loadConfig().paperclipWorkersInternalUrl).toBeNull();
  });
});

describe("createApiTierPluginWorkerManagerStub", () => {
  it("returns safe-empty for read queries", () => {
    const stub = createApiTierPluginWorkerManagerStub();
    expect(stub.getWorker("any-plugin")).toBeUndefined();
    expect(stub.isRunning("any-plugin")).toBe(false);
    expect(stub.diagnostics()).toEqual([]);
  });

  it("throws ApiTierPluginWorkerError on startWorker", async () => {
    const stub = createApiTierPluginWorkerManagerStub();
    await expect(stub.startWorker("p", {} as any)).rejects.toThrow(
      /not_available_on_api_tier|API tier/i,
    );
  });

  it("throws ApiTierPluginWorkerError on stopWorker", async () => {
    const stub = createApiTierPluginWorkerManagerStub();
    await expect(stub.stopWorker("p")).rejects.toThrow(/API tier/i);
  });

  it("throws ApiTierPluginWorkerError on call", async () => {
    const stub = createApiTierPluginWorkerManagerStub();
    await expect(stub.call("p", "shutdown" as any, {} as any)).rejects.toThrow(
      /API tier/i,
    );
  });

  it("error has 503 statusCode + 'not_available_on_api_tier' code (for HTTP layer)", async () => {
    const stub = createApiTierPluginWorkerManagerStub();
    try {
      await stub.startWorker("p", {} as any);
      expect.fail("should have thrown");
    } catch (e: any) {
      expect(e.statusCode).toBe(503);
      expect(e.code).toBe("not_available_on_api_tier");
    }
  });

  it("stopAll is a no-op (returns void without throwing)", async () => {
    const stub = createApiTierPluginWorkerManagerStub();
    await expect(stub.stopAll()).resolves.toBeUndefined();
  });
});
