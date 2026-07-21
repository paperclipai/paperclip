import { describe, expect, it } from "vitest";

import { getWorkerBootstrapSource } from "./sandboxed-parser-worker";

describe("sandboxed parser worker bootstrap", () => {
  it("disables worker network and escape globals", () => {
    const workerScope = {
      Worker: () => undefined,
      SharedWorker: () => undefined,
      Blob: () => undefined,
      RTCPeerConnection: () => undefined,
      RTCDataChannel: () => undefined,
      URL: {
        createObjectURL: () => "blob:test",
        revokeObjectURL: () => undefined,
      },
    };

    new Function("self", getWorkerBootstrapSource())(workerScope);

    expect(workerScope.Worker).toBeUndefined();
    expect(workerScope.SharedWorker).toBeUndefined();
    expect(workerScope.Blob).toBeUndefined();
    expect(workerScope.RTCPeerConnection).toBeUndefined();
    expect(workerScope.RTCDataChannel).toBeUndefined();
    expect(workerScope.URL.createObjectURL).toBeUndefined();
    expect(workerScope.URL.revokeObjectURL).toBeUndefined();
  });

  it("disables getter-only worker globals without aborting bootstrap", () => {
    const workerScope: Record<string, unknown> = {};
    Object.defineProperty(workerScope, "caches", {
      configurable: true,
      get: () => ({ sentinel: "cache-storage" }),
    });
    Object.defineProperty(workerScope, "indexedDB", {
      configurable: true,
      get: () => ({ sentinel: "indexed-db" }),
    });

    expect(() => new Function("self", getWorkerBootstrapSource())(workerScope)).not.toThrow();
    expect(workerScope.caches).toBeUndefined();
    expect(workerScope.indexedDB).toBeUndefined();
  });

  it("evaluates parser source in strict mode", () => {
    expect(getWorkerBootstrapSource()).toContain('\\"use strict\\";\\n{\\n" + msg.source');
  });

  it("does not include the unused parse_batch protocol branch", () => {
    expect(getWorkerBootstrapSource()).not.toContain("parse_batch");
  });
});
