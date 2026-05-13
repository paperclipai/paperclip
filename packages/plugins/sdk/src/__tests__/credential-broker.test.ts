import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  __consumeRegisteredCredentialBrokerFactory,
  __getRegisteredBrokerFactoryForTests,
  __resetRegistryForTests,
  registerCredentialBroker,
  type CredentialBroker,
  type RegisterCredentialBrokerCtx,
} from "../credential-broker.js";

function stubBroker(): CredentialBroker {
  return {
    id: "stub",
    mintSession: async () => ({
      sessionToken: "",
      proxyUrl: "",
      caCertPem: "",
      placeholders: {},
    }),
    pushCredential: async () => {},
    revokeSession: async () => {},
    isReachableFrom: () => false,
  };
}

describe("registerCredentialBroker", () => {
  beforeEach(() => __resetRegistryForTests());

  it("stores the factory for later resolution", () => {
    const factory = vi.fn(() => stubBroker());
    registerCredentialBroker(factory);
    expect(__getRegisteredBrokerFactoryForTests()).toBe(factory);
  });

  it("rejects double-registration with a clear error", () => {
    registerCredentialBroker(() => stubBroker());
    expect(() => registerCredentialBroker(() => stubBroker())).toThrow(
      /already registered/i,
    );
  });

  it("__consumeRegisteredCredentialBrokerFactory returns the registered factory", () => {
    const factory = () => stubBroker();
    registerCredentialBroker(factory);
    expect(__consumeRegisteredCredentialBrokerFactory()).toBe(factory);
  });

  it("__consumeRegisteredCredentialBrokerFactory returns undefined when nothing registered", () => {
    expect(__consumeRegisteredCredentialBrokerFactory()).toBeUndefined();
  });

  it("factory receives the ctx it was passed at resolution time", async () => {
    const factory = vi.fn(
      (ctx: RegisterCredentialBrokerCtx): CredentialBroker => ({
        id: ctx.logger ? "with-logger" : "no-logger",
        mintSession: async () => ({
          sessionToken: "",
          proxyUrl: "",
          caCertPem: "",
          placeholders: {},
        }),
        pushCredential: async () => {},
        revokeSession: async () => {},
        isReachableFrom: () => true,
      }),
    );
    registerCredentialBroker(factory);
    const resolved = __consumeRegisteredCredentialBrokerFactory();
    expect(resolved).toBe(factory);

    const fakeCtx: RegisterCredentialBrokerCtx = {
      resolveConnections: async () => [],
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    };
    const broker = await resolved!(fakeCtx);
    expect(broker.id).toBe("with-logger");
    expect(factory).toHaveBeenCalledWith(fakeCtx);
  });
});
