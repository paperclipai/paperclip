import { describe, expect, it } from "vitest";
import {
  deliverStoredCompanyConfig,
  type ConfigDeliveryRegistry,
  type ConfigDeliveryWorkerManager,
} from "../services/plugin-config-delivery.js";

/**
 * The host delivers stored company config to a plugin worker from two places:
 * the loader's startup replay and the operator config-save route. Delivering a
 * value captured before the send loses updates — an operator save landing
 * between the loader's `listConfigs` snapshot and the replay loop was
 * delivered first and then overwritten by the stale snapshot row.
 *
 * `deliverStoredCompanyConfig` closes that race by serializing deliveries per
 * plugin and re-reading the row inside the critical section. These tests
 * exercise exactly those two properties plus the failure-isolation of the
 * chain. No database or worker process needed: the registry and worker
 * manager are the function's only collaborators.
 */
describe("deliverStoredCompanyConfig", () => {
  interface SentConfig {
    pluginId: string;
    method: string;
    config: Record<string, unknown>;
    companyId: unknown;
  }

  function makeFakes(initialRows: Record<string, Record<string, unknown>>) {
    // rows are keyed by `${pluginId}:${companyId}` and mutable mid-test to
    // model an operator save committing while deliveries are in flight.
    const rows = new Map<string, Record<string, unknown>>(
      Object.entries(initialRows),
    );
    const sent: SentConfig[] = [];
    let callGate: Promise<void> | null = null;
    let failNextCall: Error | null = null;

    const registry: ConfigDeliveryRegistry = {
      async getConfig(pluginId, companyId) {
        const configJson = rows.get(`${pluginId}:${companyId}`);
        return configJson === undefined ? null : { configJson };
      },
    };

    const workerManager: ConfigDeliveryWorkerManager = {
      async call(pluginId, method, params) {
        if (callGate) await callGate;
        if (failNextCall) {
          const err = failNextCall;
          failNextCall = null;
          throw err;
        }
        sent.push({
          pluginId,
          method,
          config: (params?.config ?? {}) as Record<string, unknown>,
          companyId: params?.companyId,
        });
      },
    };

    return {
      registry,
      workerManager,
      rows,
      sent,
      gateCalls(gate: Promise<void>) {
        callGate = gate;
      },
      ungateCalls() {
        callGate = null;
      },
      failNext(err: Error) {
        failNextCall = err;
      },
    };
  }

  it("sends the stored row through configChanged with the company scope", async () => {
    const fakes = makeFakes({ "plugin-1:company-a": { token: "xoxb-A" } });

    const result = await deliverStoredCompanyConfig({
      registry: fakes.registry,
      workerManager: fakes.workerManager,
      pluginId: "plugin-1",
      companyId: "company-a",
    });

    expect(result).toEqual({ delivered: true });
    expect(fakes.sent).toEqual([
      {
        pluginId: "plugin-1",
        method: "configChanged",
        config: { token: "xoxb-A" },
        companyId: "company-a",
      },
    ]);
  });

  it("skips delivery when no config row exists (anymore)", async () => {
    const fakes = makeFakes({});

    const result = await deliverStoredCompanyConfig({
      registry: fakes.registry,
      workerManager: fakes.workerManager,
      pluginId: "plugin-1",
      companyId: "company-a",
    });

    expect(result).toEqual({ delivered: false, reason: "no-config" });
    expect(fakes.sent).toEqual([]);
  });

  it("delivers the latest committed value when a save lands during the startup replay", async () => {
    // The Greptile-flagged race on the original startup-replay change: the
    // loader snapshots configs, an operator save for company A commits and
    // notifies, and the replay loop then reaches company A with its stale
    // snapshot. With value-capturing delivery the worker ended on the OLD
    // config; re-reading inside the serialized critical section must leave it
    // on the NEW one no matter how the two paths interleave.
    const fakes = makeFakes({ "plugin-1:company-a": { token: "old" } });

    // Hold the replay's delivery RPC in flight after it has read the old row…
    let releaseReplay!: () => void;
    fakes.gateCalls(new Promise<void>((r) => (releaseReplay = r)));
    const replayDelivery = deliverStoredCompanyConfig({
      registry: fakes.registry,
      workerManager: fakes.workerManager,
      pluginId: "plugin-1",
      companyId: "company-a",
    });
    await new Promise((r) => setImmediate(r));

    // …while the operator save commits the new value and enqueues its own
    // delivery (what the config-save route does after upsertConfig).
    fakes.rows.set("plugin-1:company-a", { token: "new" });
    const saveDelivery = deliverStoredCompanyConfig({
      registry: fakes.registry,
      workerManager: fakes.workerManager,
      pluginId: "plugin-1",
      companyId: "company-a",
    });

    fakes.ungateCalls();
    releaseReplay();
    await Promise.all([replayDelivery, saveDelivery]);

    // The replay sent its (stale) read first, then the queued save delivery
    // re-read and sent the committed value — the worker ends on the new
    // config. Pre-fix the order was save-then-replay, ending on the old one.
    expect(fakes.sent.map((s) => s.config)).toEqual([
      { token: "old" },
      { token: "new" },
    ]);
  });

  it("serializes deliveries per plugin so sends cannot interleave", async () => {
    const fakes = makeFakes({
      "plugin-1:company-a": { token: "a" },
      "plugin-1:company-b": { token: "b" },
    });

    let releaseFirst!: () => void;
    fakes.gateCalls(new Promise<void>((r) => (releaseFirst = r)));

    const first = deliverStoredCompanyConfig({
      registry: fakes.registry,
      workerManager: fakes.workerManager,
      pluginId: "plugin-1",
      companyId: "company-a",
    });
    const second = deliverStoredCompanyConfig({
      registry: fakes.registry,
      workerManager: fakes.workerManager,
      pluginId: "plugin-1",
      companyId: "company-b",
    });

    // The second delivery is queued behind the gated first one.
    await new Promise((r) => setImmediate(r));
    expect(fakes.sent).toEqual([]);

    fakes.ungateCalls();
    releaseFirst();
    await Promise.all([first, second]);

    expect(fakes.sent.map((s) => s.companyId)).toEqual(["company-a", "company-b"]);
  });

  it("propagates RPC errors to the caller without breaking the chain", async () => {
    const fakes = makeFakes({
      "plugin-1:company-a": { token: "a" },
      "plugin-1:company-b": { token: "b" },
    });
    fakes.failNext(Object.assign(new Error("cross-tenant"), { code: -32099 }));

    await expect(
      deliverStoredCompanyConfig({
        registry: fakes.registry,
        workerManager: fakes.workerManager,
        pluginId: "plugin-1",
        companyId: "company-a",
      }),
    ).rejects.toMatchObject({ message: "cross-tenant", code: -32099 });

    // A failed delivery must not wedge later ones (the loader's replay loop
    // continues to the next company after logging).
    await expect(
      deliverStoredCompanyConfig({
        registry: fakes.registry,
        workerManager: fakes.workerManager,
        pluginId: "plugin-1",
        companyId: "company-b",
      }),
    ).resolves.toEqual({ delivered: true });
    expect(fakes.sent.map((s) => s.companyId)).toEqual(["company-b"]);
  });
});
