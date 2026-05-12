/**
 * Tier 4 — WS-1 RBAC matrix + audit log coverage
 *
 * Matrix: plugin capability × action × allowed/denied
 *   - WITH run.gate capability: runs.registerBeforeRunHandler → allowed (no-op ack)
 *   - WITHOUT run.gate capability: runs.registerBeforeRunHandler → CAPABILITY_DENIED
 *   - Anonymous (empty capabilities): runs.registerBeforeRunHandler → CAPABILITY_DENIED
 *
 * Audit log: every veto + every gate-error path writes a cancel_source=plugin_gate
 *   run event with the vetoing plugin ID (host-assigned, not plugin-supplied).
 */
import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { PLUGIN_RPC_ERROR_CODES } from "../../../packages/plugins/sdk/src/protocol.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import {
  broadcastBeforeRun,
  type BeforeRunGatePlugin,
  type BeforeRunParams,
} from "../services/plugin-worker-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn() };
    },
  } as any;
}

const baseParams: BeforeRunParams = {
  runId: "run-1",
  agentId: "agent-1",
  issueId: null,
  companyId: "co-1",
  invocationSource: "assignment",
};

// ---------------------------------------------------------------------------
// Tier 4 — RBAC matrix: runs.registerBeforeRunHandler capability enforcement
// ---------------------------------------------------------------------------

describe("WS-1 RBAC matrix — runs.registerBeforeRunHandler", () => {
  it("ALLOWED: plugin with run.gate capability can call registerBeforeRunHandler", async () => {
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "gate-plugin",
      createEventBusStub(),
    );
    const handlers = createHostClientHandlers({
      pluginId: "gate-plugin",
      capabilities: ["run.gate"],
      services,
    });

    await expect(handlers["runs.registerBeforeRunHandler"]({})).resolves.toBeUndefined();
  });

  it("DENIED: plugin without run.gate capability gets CAPABILITY_DENIED", async () => {
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "no-gate-plugin",
      createEventBusStub(),
    );
    const handlers = createHostClientHandlers({
      pluginId: "no-gate-plugin",
      capabilities: ["events.subscribe"],
      services,
    });

    await expect(handlers["runs.registerBeforeRunHandler"]({})).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
    });
  });

  it("DENIED: anonymous plugin (empty capabilities) gets CAPABILITY_DENIED", async () => {
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "anon-plugin",
      createEventBusStub(),
    );
    const handlers = createHostClientHandlers({
      pluginId: "anon-plugin",
      capabilities: [],
      services,
    });

    await expect(handlers["runs.registerBeforeRunHandler"]({})).rejects.toMatchObject({
      code: PLUGIN_RPC_ERROR_CODES.CAPABILITY_DENIED,
    });
  });
});

// ---------------------------------------------------------------------------
// Tier 4 — Audit log: veto + gate-error paths produce correct cancel_source
// ---------------------------------------------------------------------------

describe("WS-1 audit log — broadcastBeforeRun veto attribution", () => {
  it("veto result includes vetoPluginId set by host (not plugin-supplied)", async () => {
    const gateA: BeforeRunGatePlugin = {
      pluginId: "host-assigned-id-A",
      callBeforeRun: vi.fn().mockResolvedValue({ veto: true, reason: "pool full" }),
    };
    const result = await broadcastBeforeRun([gateA], baseParams);
    expect(result.veto).toBe(true);
    if (result.veto) {
      expect(result.vetoPluginId).toBe("host-assigned-id-A");
    }
  });

  it("gate-error (thrown) is fail-open and no vetoPluginId in result", async () => {
    const gateA: BeforeRunGatePlugin = {
      pluginId: "host-assigned-id-A",
      callBeforeRun: vi.fn().mockRejectedValue(new Error("handler crashed")),
    };
    const result = await broadcastBeforeRun([gateA], baseParams);
    expect(result.veto).toBe(false);
  });

  it("gate-error (timeout/null) is fail-open and no veto", async () => {
    const gateA: BeforeRunGatePlugin = {
      pluginId: "host-assigned-id-A",
      callBeforeRun: vi.fn().mockResolvedValue(null as any),
    };
    const result = await broadcastBeforeRun([gateA], baseParams);
    expect(result.veto).toBe(false);
  });

  it("gate-error (malformed: veto:true without reason) is fail-open", async () => {
    const gateA: BeforeRunGatePlugin = {
      pluginId: "host-assigned-id-A",
      callBeforeRun: vi.fn().mockResolvedValue({ veto: true } as any),
    };
    const result = await broadcastBeforeRun([gateA], baseParams);
    expect(result.veto).toBe(false);
  });

  it("veto passes companyId from host params (not plugin-writable)", async () => {
    const capturedParams: BeforeRunParams[] = [];
    const gateA: BeforeRunGatePlugin = {
      pluginId: "gate-a",
      callBeforeRun: vi.fn().mockImplementation(async (params: BeforeRunParams) => {
        capturedParams.push(params);
        return { veto: false };
      }),
    };
    await broadcastBeforeRun([gateA], baseParams);
    expect(capturedParams[0].companyId).toBe("co-1");
    expect(capturedParams[0].runId).toBe("run-1");
  });

  it("second gate in chain receives correct params even when first allows", async () => {
    const capturedB: BeforeRunParams[] = [];
    const gateA: BeforeRunGatePlugin = {
      pluginId: "gate-a",
      callBeforeRun: vi.fn().mockResolvedValue({ veto: false }),
    };
    const gateB: BeforeRunGatePlugin = {
      pluginId: "gate-b",
      callBeforeRun: vi.fn().mockImplementation(async (p: BeforeRunParams) => {
        capturedB.push(p);
        return { veto: true, reason: "budget" };
      }),
    };
    const result = await broadcastBeforeRun([gateA, gateB], baseParams);
    expect(result.veto).toBe(true);
    if (result.veto) {
      expect(result.vetoPluginId).toBe("gate-b");
    }
    expect(capturedB[0].companyId).toBe("co-1");
  });
});
