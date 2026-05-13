import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetRegistryForTests,
  registerCredentialBroker,
  type CredentialBroker,
  type RegisterCredentialBrokerCtx,
} from "@paperclipai/plugin-sdk";

import {
  __resetResolvedBrokerForTests,
  resolveCredentialBroker,
} from "./credential-broker-registry.js";

function stubBroker(overrides: Partial<CredentialBroker> = {}): CredentialBroker {
  return {
    id: "test-stub",
    mintSession: async () => ({
      sessionToken: "tok",
      proxyUrl: "http://127.0.0.1:0",
      caCertPem: "",
      placeholders: {},
    }),
    pushCredential: async () => {},
    revokeSession: async () => {},
    isReachableFrom: () => false,
    ...overrides,
  };
}

const ctx: RegisterCredentialBrokerCtx = {
  resolveConnections: async () => [],
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
};

beforeEach(() => {
  __resetRegistryForTests();
  __resetResolvedBrokerForTests();
});

describe("resolveCredentialBroker", () => {
  it("returns undefined when no broker is registered", async () => {
    expect(await resolveCredentialBroker(ctx)).toBeUndefined();
  });

  it("returns the registered broker once", async () => {
    registerCredentialBroker(() => stubBroker({ id: "alpha" }));
    const b = await resolveCredentialBroker(ctx);
    expect(b?.id).toBe("alpha");
  });

  it("caches the resolved broker across calls; factory runs exactly once", async () => {
    const factory = vi.fn(() => stubBroker({ id: "cached" }));
    registerCredentialBroker(factory);
    const first = await resolveCredentialBroker(ctx);
    const second = await resolveCredentialBroker(ctx);
    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("caches the undefined-resolution result too", async () => {
    expect(await resolveCredentialBroker(ctx)).toBeUndefined();
    // Even if a broker is registered AFTER the first resolve, the cached
    // "no broker" outcome stands until __resetResolvedBrokerForTests.
    registerCredentialBroker(() => stubBroker({ id: "late" }));
    expect(await resolveCredentialBroker(ctx)).toBeUndefined();
  });

  it("supports an async factory", async () => {
    registerCredentialBroker(async () => {
      await new Promise((r) => setTimeout(r, 1));
      return stubBroker({ id: "async-ok" });
    });
    const b = await resolveCredentialBroker(ctx);
    expect(b?.id).toBe("async-ok");
  });

  it("passes the supplied ctx to the factory", async () => {
    const factory = vi.fn((c: RegisterCredentialBrokerCtx) =>
      stubBroker({ id: c.logger ? "with-logger" : "no-logger" }),
    );
    registerCredentialBroker(factory);
    const b = await resolveCredentialBroker(ctx);
    expect(b?.id).toBe("with-logger");
    expect(factory).toHaveBeenCalledWith(ctx);
  });

  it("dedupes concurrent first dispatches; factory runs exactly once even under contention", async () => {
    // Regression for the double-init race: without the in-flight
    // `pending` promise, two concurrent first dispatches both see
    // `resolved=false`, both call `factory()`, and the second's
    // broker overwrites the first — leaking the first instance's
    // state. With the fix, both calls await the same Promise and
    // factory fires exactly once.
    const factory = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return stubBroker({ id: "single-init" });
    });
    registerCredentialBroker(factory);
    const [a, b, c] = await Promise.all([
      resolveCredentialBroker(ctx),
      resolveCredentialBroker(ctx),
      resolveCredentialBroker(ctx),
    ]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a?.id).toBe("single-init");
  });
});
