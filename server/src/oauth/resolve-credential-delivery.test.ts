import { describe, expect, it } from "vitest";

import type {
  CredentialBroker,
  ExecutionTargetSummary,
} from "@paperclipai/plugin-sdk";

import {
  resolveCredentialDelivery,
  type OAuthBindingSummary,
  type ResolveCredentialDeliveryInput,
} from "./resolve-credential-delivery.js";

const stubBroker = (reachable: boolean): CredentialBroker => ({
  id: "stub",
  mintSession: async () => ({
    sessionToken: "",
    proxyUrl: "",
    caCertPem: "",
    placeholders: {},
  }),
  pushCredential: async () => {},
  revokeSession: async () => {},
  isReachableFrom: () => reachable,
});

const local: ExecutionTargetSummary = { kind: "local" };
const external: ExecutionTargetSummary = { kind: "external" };
const webhook: ExecutionTargetSummary = { kind: "webhook" };
const e2b: ExecutionTargetSummary = {
  kind: "sandbox",
  sandboxProvider: "e2b",
};

const oneBinding: OAuthBindingSummary[] = [
  { envVarName: "GH", connectionId: "c-1", field: "access" },
];

const twoBindings: OAuthBindingSummary[] = [
  { envVarName: "GH", connectionId: "c-1", field: "access" },
  { envVarName: "SL", connectionId: "c-2", field: "access" },
];

function input(
  overrides: Partial<ResolveCredentialDeliveryInput>,
): ResolveCredentialDeliveryInput {
  return {
    explicit: undefined,
    executionTarget: local,
    oauthBindings: oneBinding,
    registeredBroker: undefined,
    hasBrokerTargetsFor: () => false,
    providerBrokerSupported: () => true,
    ...overrides,
  };
}

describe("resolveCredentialDelivery", () => {
  it("honors explicit config when set", () => {
    expect(
      resolveCredentialDelivery(
        input({
          explicit: "env",
          registeredBroker: stubBroker(true),
        }),
      ),
    ).toEqual({ mode: "env", reason: "explicit_config" });

    expect(
      resolveCredentialDelivery(input({ explicit: "paperclip-broker" })),
    ).toEqual({ mode: "paperclip-broker", reason: "explicit_config" });

    expect(
      resolveCredentialDelivery(input({ explicit: "byo-broker" })),
    ).toEqual({ mode: "byo-broker", reason: "explicit_config" });
  });

  it("returns env with no_oauth_bindings when there are no bindings", () => {
    expect(
      resolveCredentialDelivery(
        input({ oauthBindings: [], registeredBroker: stubBroker(true) }),
      ),
    ).toEqual({ mode: "env", reason: "no_oauth_bindings" });
  });

  it("returns env when any binding's provider isn't broker-compatible", () => {
    const r = resolveCredentialDelivery(
      input({
        oauthBindings: twoBindings,
        registeredBroker: stubBroker(true),
        providerBrokerSupported: (cid) => cid !== "c-2",
      }),
    );
    expect(r).toEqual({
      mode: "env",
      reason: "provider_not_broker_compatible",
    });
  });

  it("external runtime + all bindings have BYO targets → byo-broker", () => {
    expect(
      resolveCredentialDelivery(
        input({
          executionTarget: external,
          hasBrokerTargetsFor: () => true,
        }),
      ),
    ).toEqual({ mode: "byo-broker", reason: "external_runtime_with_byo_targets" });
  });

  it("webhook runtime is treated as external", () => {
    expect(
      resolveCredentialDelivery(
        input({
          executionTarget: webhook,
          hasBrokerTargetsFor: () => true,
        }),
      ),
    ).toEqual({
      mode: "byo-broker",
      reason: "external_runtime_with_byo_targets",
    });
  });

  it("external runtime + any binding without BYO target → env", () => {
    const r = resolveCredentialDelivery(
      input({
        executionTarget: external,
        oauthBindings: twoBindings,
        hasBrokerTargetsFor: (cid) => cid === "c-1",
      }),
    );
    expect(r).toEqual({
      mode: "env",
      reason: "external_runtime_no_broker_targets",
    });
  });

  it("paperclip-spawned runtime + reachable broker → paperclip-broker", () => {
    expect(
      resolveCredentialDelivery(
        input({
          executionTarget: local,
          registeredBroker: stubBroker(true),
        }),
      ),
    ).toEqual({
      mode: "paperclip-broker",
      reason: "broker_available_and_reachable",
    });
  });

  it("paperclip-spawned runtime + broker present but unreachable → env", () => {
    expect(
      resolveCredentialDelivery(
        input({
          executionTarget: e2b,
          registeredBroker: stubBroker(false),
        }),
      ),
    ).toEqual({
      mode: "env",
      reason: "broker_unreachable_from_runtime",
    });
  });

  it("paperclip-spawned runtime + no broker registered → env", () => {
    expect(
      resolveCredentialDelivery(
        input({
          executionTarget: local,
          registeredBroker: undefined,
        }),
      ),
    ).toEqual({ mode: "env", reason: "no_broker_registered" });
  });

  it("explicit env config beats every other signal, even when broker is available", () => {
    expect(
      resolveCredentialDelivery(
        input({
          explicit: "env",
          executionTarget: local,
          registeredBroker: stubBroker(true),
          hasBrokerTargetsFor: () => true,
        }),
      ),
    ).toEqual({ mode: "env", reason: "explicit_config" });
  });

  it("provider_not_broker_compatible short-circuits before runtime checks", () => {
    const r = resolveCredentialDelivery(
      input({
        executionTarget: external,
        registeredBroker: stubBroker(true),
        hasBrokerTargetsFor: () => true,
        providerBrokerSupported: () => false,
      }),
    );
    expect(r.reason).toBe("provider_not_broker_compatible");
  });
});
