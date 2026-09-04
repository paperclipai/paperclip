import { describe, expect, it } from "vitest";

import { RUNTIME_EXPOSURE_APP_PORT_MIN, deriveViteHmrPort } from "@paperclipai/shared";

import {
  BrokerClientError,
  type BrokerClient,
  type BrokerExposeResult,
  type BrokerListenerRequest,
  type BrokerOwnedListener,
  type BrokerReserveResult,
  type BrokerRemoveResult,
} from "./broker-client.js";
import {
  deprovisionExposure,
  provisionExposure,
  reconcileExposures,
  reserveExposure,
  type ExposureManagerDeps,
} from "./exposure-manager.js";

const RUNTIME_ID = "11111111-2222-4333-8444-555566667777";
const APP_PORT = RUNTIME_EXPOSURE_APP_PORT_MIN;
const HMR_PORT = deriveViteHmrPort(APP_PORT);
const HOSTNAME = "runner-abc.tail-scale.ts.net";

const CONFIG = {
  type: "tailscale_https" as const,
  hostname: "auto" as const,
  publicPort: "same" as const,
  includePaperclipViteHmr: true,
  failurePolicy: "fail_closed" as const,
};

interface FakeBrokerScript {
  reserve?: (runtimeId: string, listeners: BrokerListenerRequest[]) => BrokerReserveResult;
  expose?: (runtimeId: string, handle: string) => BrokerExposeResult;
  remove?: (runtimeId: string, handle: string) => BrokerRemoveResult;
  list?: () => BrokerOwnedListener[];
}

interface FakeBrokerCalls {
  reserve: Array<{ runtimeId: string; listeners: BrokerListenerRequest[] }>;
  expose: Array<{ runtimeId: string; handle: string }>;
  remove: Array<{ runtimeId: string; handle: string }>;
  list: number;
}

function fakeBroker(script: FakeBrokerScript): { broker: BrokerClient; calls: FakeBrokerCalls } {
  const calls: FakeBrokerCalls = { reserve: [], expose: [], remove: [], list: 0 };
  const broker: BrokerClient = {
    async reserve(runtimeId, listeners) {
      calls.reserve.push({ runtimeId, listeners });
      if (!script.reserve) throw new BrokerClientError("internal_error", "no reserve script");
      return script.reserve(runtimeId, listeners);
    },
    async expose(runtimeId, handle) {
      calls.expose.push({ runtimeId, handle });
      if (!script.expose) throw new BrokerClientError("internal_error", "no expose script");
      return script.expose(runtimeId, handle);
    },
    async remove(runtimeId, handle) {
      calls.remove.push({ runtimeId, handle });
      if (!script.remove) throw new BrokerClientError("internal_error", "no remove script");
      return script.remove(runtimeId, handle);
    },
    async list() {
      calls.list += 1;
      return script.list ? script.list() : [];
    },
  };
  return { broker, calls };
}

const HANDLE = "handle-abcdef1234567890";

describe("reserveExposure", () => {
  it("reserves the exact app + HMR pair before startup", async () => {
    const { broker, calls } = fakeBroker({
      reserve: () => ({ handle: HANDLE, reservedPorts: [APP_PORT, HMR_PORT] }),
    });
    const result = await reserveExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      appPort: APP_PORT,
    });
    expect(calls.reserve).toEqual([{
      runtimeId: RUNTIME_ID,
      listeners: [
        { purpose: "app", port: APP_PORT },
        { purpose: "vite_hmr", port: HMR_PORT },
      ],
    }]);
    expect(result.handle).toBe(HANDLE);
    expect(result.status.state).toBe("pending");
  });

  it("releases a malformed reservation response and fails closed", async () => {
    const { broker, calls } = fakeBroker({
      reserve: () => ({ handle: HANDLE, reservedPorts: [APP_PORT] }),
      remove: () => ({ removedPorts: [] }),
    });
    const result = await reserveExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      appPort: APP_PORT,
    });
    expect(result.status.state).toBe("failed");
    expect(result.handle).toBeNull();
    expect(calls.remove).toEqual([{ runtimeId: RUNTIME_ID, handle: HANDLE }]);
  });
});

function deps(broker: BrokerClient, probeHealth: () => Promise<boolean>): ExposureManagerDeps {
  return { broker, probeHealth, now: () => "2026-08-11T00:00:00.000Z" };
}

describe("provisionExposure loopback diagnosis (PAP-17256)", () => {
  it("fails before touching the broker when a listener is provably off-loopback", async () => {
    const { broker, calls } = fakeBroker({
      expose: () => ({ handle: HANDLE, publicPorts: [APP_PORT, HMR_PORT] }),
    });
    const seen: number[][] = [];
    const result = await provisionExposure(
      {
        ...deps(broker, async () => true),
        diagnoseListenerBinds: async (ports) => {
          seen.push(ports);
          return `port ${APP_PORT} is bound to 0.0.0.0 instead of loopback only`;
        },
      },
      { runtimeId: RUNTIME_ID, config: CONFIG, handle: HANDLE, hostname: HOSTNAME, appPort: APP_PORT },
    );

    // Both the app port and its HMR companion are diagnosed, because the broker
    // gates on both and either one can be the wildcard bind.
    expect(seen).toEqual([[APP_PORT, HMR_PORT]]);
    expect(calls.expose).toHaveLength(0);
    expect(result.status.state).toBe("failed");
    // The persisted code stays the broker's own vocabulary so retry/cleanup
    // matching is unchanged; the reason rides alongside.
    expect(result.status.lastError).toBe("listener_ownership_mismatch");
    expect(result.errorDetail).toContain("0.0.0.0");
    // The reservation handle survives so the caller can still tear the lease down.
    expect(result.handle).toBe(HANDLE);
  });

  it("exposes normally when the diagnosis finds nothing wrong", async () => {
    const { broker, calls } = fakeBroker({
      expose: () => ({ handle: HANDLE, publicPorts: [APP_PORT, HMR_PORT] }),
    });
    const result = await provisionExposure(
      { ...deps(broker, async () => true), diagnoseListenerBinds: async () => null },
      { runtimeId: RUNTIME_ID, config: CONFIG, handle: HANDLE, hostname: HOSTNAME, appPort: APP_PORT },
    );
    expect(calls.expose).toHaveLength(1);
    expect(result.status.state).toBe("ready");
    expect(result.errorDetail ?? null).toBeNull();
  });

  it("surfaces the broker's own reason alongside its code", async () => {
    const { broker } = fakeBroker({
      expose: () => {
        throw new BrokerClientError(
          "listener_ownership_mismatch",
          `listener on ${APP_PORT} is not loopback-only`,
        );
      },
    });
    const result = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      handle: HANDLE,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(result.status.lastError).toBe("listener_ownership_mismatch");
    expect(result.errorDetail).toBe(`listener on ${APP_PORT} is not loopback-only`);
  });

  it("does not repeat the code as a reason when the broker adds nothing", async () => {
    const { broker } = fakeBroker({
      expose: () => {
        throw new BrokerClientError("cli_timeout", "cli_timeout");
      },
    });
    const result = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      handle: HANDLE,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(result.status.lastError).toBe("cli_timeout");
    expect(result.errorDetail).toBeNull();
  });
});

describe("provisionExposure", () => {
  it("exposes app + HMR and reports ready once the HTTPS probe validates", async () => {
    const { broker, calls } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT, HMR_PORT] }),
    });
    const { status, handle } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      handle: HANDLE,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });

    expect(calls.expose).toHaveLength(1);
    expect(calls.expose).toEqual([{ runtimeId: RUNTIME_ID, handle: HANDLE }]);
    expect(status.state).toBe("ready");
    expect(status.publicUrl).toBe(`https://${HOSTNAME}:${APP_PORT}`);
    expect(status.hostname).toBe(HOSTNAME);
    expect(status.listeners).toHaveLength(2);
    expect(status.brokerRef).toBe(RUNTIME_ID);
    expect(status.lastError).toBeNull();
    expect(handle).toBe("handle-abcdef1234567890");
  });

  it("omits the HMR listener when HMR is not requested", async () => {
    const { broker, calls } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT] }),
    });
    const { status } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: { ...CONFIG, includePaperclipViteHmr: false },
      handle: HANDLE,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(calls.expose).toEqual([{ runtimeId: RUNTIME_ID, handle: HANDLE }]);
    expect(status.listeners).toEqual([{ purpose: "app", publicPort: APP_PORT, targetPort: APP_PORT }]);
    expect(status.state).toBe("ready");
  });

  it("fails closed without calling the broker when the app port is out of range", async () => {
    const { broker, calls } = fakeBroker({});
    const { status, handle } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      handle: HANDLE,
      hostname: HOSTNAME,
      appPort: 3100, // primary app port — never eligible
    });
    expect(calls.expose).toHaveLength(0);
    expect(status.state).toBe("failed");
    expect(handle).toBe(HANDLE);
  });

  it("fails when the broker rejects the expose request", async () => {
    const { broker } = fakeBroker({
      expose: () => {
        throw new BrokerClientError("port_not_allowlisted", "denied");
      },
    });
    const { status, handle } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      handle: HANDLE,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(status.state).toBe("failed");
    expect(status.lastError).toBe("port_not_allowlisted");
    expect(status.listeners).toHaveLength(2);
    expect(handle).toBe(HANDLE);
  });

  it("tears the mapping back down and fails when returned ports do not match", async () => {
    const { broker, calls } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT] }), // missing HMR
      remove: () => ({ removedPorts: [APP_PORT] }),
    });
    const { status, handle } = await provisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      handle: HANDLE,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(status.state).toBe("failed");
    expect(status.lastError).toMatch(/unexpected public ports/);
    expect(calls.remove).toHaveLength(1); // best-effort rollback
    expect(handle).toBe(HANDLE);
  });

  it("fail-closed: keeps the handle but reports failed when the HTTPS probe does not validate", async () => {
    const { broker } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT, HMR_PORT] }),
    });
    const { status, handle } = await provisionExposure(deps(broker, async () => false), {
      runtimeId: RUNTIME_ID,
      config: CONFIG,
      handle: HANDLE,
      hostname: HOSTNAME,
      appPort: APP_PORT,
    });
    expect(status.state).toBe("failed");
    expect(status.publicUrl).toBeNull();
    expect(status.listeners).toHaveLength(2); // attempted mapping still surfaced
    expect(status.lastError).toMatch(/health probe/);
    // Handle retained so the caller can retry or clean up the dangling mapping.
    expect(handle).toBe("handle-abcdef1234567890");
  });

  it("fail-closed: treats a probe that throws as unhealthy", async () => {
    const { broker } = fakeBroker({
      expose: () => ({ handle: "handle-abcdef1234567890", publicPorts: [APP_PORT, HMR_PORT] }),
    });
    const { status } = await provisionExposure(
      deps(broker, async () => {
        throw new Error("cert error");
      }),
      { runtimeId: RUNTIME_ID, config: CONFIG, handle: HANDLE, hostname: HOSTNAME, appPort: APP_PORT },
    );
    expect(status.state).toBe("failed");
  });
});

describe("deprovisionExposure", () => {
  it("is a no-op removal when no handle was ever recorded", async () => {
    const { broker, calls } = fakeBroker({});
    const { status, quarantinedPorts } = await deprovisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      handle: null,
      ports: [APP_PORT, HMR_PORT],
    });
    expect(calls.remove).toHaveLength(0);
    expect(status.state).toBe("removed");
    expect(quarantinedPorts).toEqual([]);
  });

  it("removes cleanly with a handle", async () => {
    const { broker, calls } = fakeBroker({ remove: () => ({ removedPorts: [APP_PORT, HMR_PORT] }) });
    const { status, quarantinedPorts } = await deprovisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      handle: "handle-abcdef1234567890",
      ports: [APP_PORT, HMR_PORT],
    });
    expect(calls.remove).toHaveLength(1);
    expect(status.state).toBe("removed");
    expect(quarantinedPorts).toEqual([]);
  });

  it("treats an already-gone mapping as removed (idempotent)", async () => {
    const { broker } = fakeBroker({
      remove: () => {
        throw new BrokerClientError("invalid_handle", "gone");
      },
    });
    const { status, quarantinedPorts } = await deprovisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      handle: "handle-abcdef1234567890",
      ports: [APP_PORT, HMR_PORT],
    });
    expect(status.state).toBe("removed");
    expect(quarantinedPorts).toEqual([]);
  });

  it("quarantines ports and reports cleanup_pending on an ambiguous cleanup failure", async () => {
    const { broker } = fakeBroker({
      remove: () => {
        throw new BrokerClientError("cli_error", "tailscale serve failed");
      },
    });
    const { status, quarantinedPorts } = await deprovisionExposure(deps(broker, async () => true), {
      runtimeId: RUNTIME_ID,
      handle: "handle-abcdef1234567890",
      ports: [APP_PORT, HMR_PORT, APP_PORT],
    });
    expect(status.state).toBe("cleanup_pending");
    expect(status.lastError).toBe("cli_error");
    expect(quarantinedPorts).toEqual([APP_PORT, HMR_PORT]); // deduped
  });
});

describe("reconcileExposures", () => {
  it("adopts owned mappings that are still desired", async () => {
    const { broker, calls } = fakeBroker({
      list: () => [
        { runtimeId: RUNTIME_ID, port: APP_PORT, purpose: "app" },
        { runtimeId: RUNTIME_ID, port: HMR_PORT, purpose: "vite_hmr" },
      ],
    });
    const result = await reconcileExposures(deps(broker, async () => true), {
      desiredRuntimeIds: new Set([RUNTIME_ID]),
      handlesByRuntimeId: new Map(),
    });
    expect(result.adopted).toEqual([RUNTIME_ID]);
    expect(result.removedOrphanPorts).toEqual([]);
    expect(calls.remove).toHaveLength(0);
  });

  it("removes an orphaned owned mapping when a handle is available", async () => {
    const orphan = "99999999-2222-4333-8444-555566667777";
    const { broker, calls } = fakeBroker({
      list: () => [{ runtimeId: orphan, port: APP_PORT, purpose: "app" }],
      remove: () => ({ removedPorts: [APP_PORT] }),
    });
    const result = await reconcileExposures(deps(broker, async () => true), {
      desiredRuntimeIds: new Set([RUNTIME_ID]),
      handlesByRuntimeId: new Map([[orphan, "handle-abcdef1234567890"]]),
    });
    expect(result.removedOrphanPorts).toEqual([APP_PORT]);
    expect(calls.remove).toEqual([{ runtimeId: orphan, handle: "handle-abcdef1234567890" }]);
    expect(result.unremovableOrphans).toEqual([]);
  });

  it("never mutates an orphan it has no handle for (no remove call)", async () => {
    const orphan = "99999999-2222-4333-8444-555566667777";
    const { broker, calls } = fakeBroker({
      list: () => [{ runtimeId: orphan, port: APP_PORT, purpose: "app" }],
    });
    const result = await reconcileExposures(deps(broker, async () => true), {
      desiredRuntimeIds: new Set([RUNTIME_ID]),
      handlesByRuntimeId: new Map(),
    });
    expect(calls.remove).toHaveLength(0);
    expect(result.unremovableOrphans).toEqual([orphan]);
    expect(result.removedOrphanPorts).toEqual([]);
  });

  it("records non-fatal errors without aborting reconciliation", async () => {
    const orphanA = "aaaaaaaa-2222-4333-8444-555566667777";
    const orphanB = "bbbbbbbb-2222-4333-8444-555566667777";
    const { broker } = fakeBroker({
      list: () => [
        { runtimeId: orphanA, port: APP_PORT, purpose: "app" },
        { runtimeId: orphanB, port: APP_PORT + 1, purpose: "app" },
      ],
      remove: (runtimeId) => {
        if (runtimeId === orphanA) throw new BrokerClientError("cli_error", "boom");
        return { removedPorts: [APP_PORT + 1] };
      },
    });
    const result = await reconcileExposures(deps(broker, async () => true), {
      desiredRuntimeIds: new Set(),
      handlesByRuntimeId: new Map([
        [orphanA, "handle-aaaaaaaaaaaaaaaa"],
        [orphanB, "handle-bbbbbbbbbbbbbbbb"],
      ]),
    });
    expect(result.errors).toEqual([{ runtimeId: orphanA, code: "cli_error" }]);
    expect(result.removedOrphanPorts).toEqual([APP_PORT + 1]);
  });
});
