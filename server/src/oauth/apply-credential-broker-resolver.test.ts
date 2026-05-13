import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetRegistryForTests,
  registerCredentialBroker,
  type CredentialBroker,
} from "@paperclipai/plugin-sdk";

import { __resetResolvedBrokerForTests } from "../plugins/credential-broker-registry.js";
import { __clearCredentialBrokerFlagsForTests } from "../config/credential-broker-flags.js";
import { ProviderRegistry } from "./registry.js";
import {
  applyCredentialBrokerResolver,
  CredentialBrokerRequiredError,
} from "./apply-credential-broker-resolver.js";

const CONNECTION_ID = "11111111-2222-3333-4444-555555555555";
const COMPANY_ID = "00000000-0000-0000-0000-000000000000";

function fakeDb(rows: Array<{ id: string; providerId: string; brokerTargets: unknown[] }>) {
  const select = () => ({
    from: () => ({
      where: () => Promise.resolve(rows),
    }),
  });
  return { select } as unknown as Parameters<typeof applyCredentialBrokerResolver>[0]["db"];
}

function fakeRegistry(brokerSupported: boolean): ProviderRegistry {
  const env = { GH_ID: "id", GH_SECRET: "s" };
  const registry = new ProviderRegistry({ env });
  registry.register(
    {
      id: "github",
      displayName: "GitHub",
      clientCredentials: { clientIdEnv: "GH_ID", clientSecretEnv: "GH_SECRET" },
      endpoints: {
        authorize: "https://x/a",
        token: "https://x/t",
        accountInfo: "https://x/me",
      },
      scopes: { default: [], offered: [] },
      pkce: "required",
      authMethod: "post",
      responseFormat: "json",
      accountIdField: "id",
      accountLabelField: "login",
      refresh: { supported: false },
      broker: brokerSupported
        ? { supported: true, deliveryModesSupported: ["paperclip-broker", "env"] }
        : { supported: false, deliveryModesSupported: ["env"] },
    },
    "yaml",
  );
  return registry;
}

function fakeLogger() {
  const warn = vi.fn();
  const debug = vi.fn();
  return { warn, debug, info: vi.fn(), error: vi.fn() };
}

function stubBroker(reachable: boolean): CredentialBroker {
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
    isReachableFrom: () => reachable,
  };
}

const oauthBinding = {
  type: "oauth_token" as const,
  connectionId: CONNECTION_ID,
  field: "access" as const,
};

beforeEach(() => {
  __resetRegistryForTests();
  __resetResolvedBrokerForTests();
  __clearCredentialBrokerFlagsForTests();
});

afterEach(() => {
  __clearCredentialBrokerFlagsForTests();
});

describe("applyCredentialBrokerResolver — feature flag off", () => {
  it("is a no-op when the flag is off and there is no explicit override", async () => {
    const logger = fakeLogger();
    const result = await applyCredentialBrokerResolver(
      {
        db: fakeDb([]),
        registry: fakeRegistry(false),
        logger: logger as never,
      },
      {
        companyId: COMPANY_ID,
        envRecord: { GH: oauthBinding },
      },
    );
    expect(result.ran).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("still runs when an explicit override is set on the agent config (operator intent)", async () => {
    const logger = fakeLogger();
    const result = await applyCredentialBrokerResolver(
      {
        db: fakeDb([{ id: CONNECTION_ID, providerId: "github", brokerTargets: [] }]),
        registry: fakeRegistry(false),
        logger: logger as never,
      },
      {
        companyId: COMPANY_ID,
        envRecord: { GH: oauthBinding },
        explicit: "env",
      },
    );
    expect(result.ran).toBe(true);
    expect(result.decision?.reason).toBe("explicit_config");
    // explicit_config does not trigger a warn — operator opted in.
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("applyCredentialBrokerResolver — feature flag on, no broker registered", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = "1";
  });

  it("returns env decision and emits the fallback warn-log", async () => {
    const logger = fakeLogger();
    const result = await applyCredentialBrokerResolver(
      {
        db: fakeDb([{ id: CONNECTION_ID, providerId: "github", brokerTargets: [] }]),
        registry: fakeRegistry(false),
        logger: logger as never,
      },
      {
        companyId: COMPANY_ID,
        envRecord: { GH: oauthBinding },
        runId: "run-1",
        agentId: "a-1",
      },
    );
    expect(result.ran).toBe(true);
    expect(result.decision).toEqual({
      mode: "env",
      reason: "provider_not_broker_compatible",
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload] = logger.warn.mock.calls[0];
    expect(payload).toMatchObject({
      event: "credential-broker-fallback-to-env",
      reason: "provider_not_broker_compatible",
      runId: "run-1",
      agentId: "a-1",
    });
  });

  it("emits no warn-log when the dispatch has no oauth bindings", async () => {
    const logger = fakeLogger();
    const result = await applyCredentialBrokerResolver(
      {
        db: fakeDb([]),
        registry: fakeRegistry(false),
        logger: logger as never,
      },
      {
        companyId: COMPANY_ID,
        envRecord: { API_KEY: { type: "secret_ref", secretId: CONNECTION_ID } },
      },
    );
    expect(result.ran).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("returns env / no_broker_registered when the provider supports the broker but none is registered", async () => {
    const logger = fakeLogger();
    const result = await applyCredentialBrokerResolver(
      {
        db: fakeDb([{ id: CONNECTION_ID, providerId: "github", brokerTargets: [] }]),
        registry: fakeRegistry(true), // provider says supported
        logger: logger as never,
      },
      {
        companyId: COMPANY_ID,
        envRecord: { GH: oauthBinding },
        runId: "run-2",
        agentId: "a-2",
      },
    );
    expect(result.decision).toEqual({
      mode: "env",
      reason: "no_broker_registered",
    });
    const [payload] = logger.warn.mock.calls[0];
    expect(payload).toMatchObject({
      reason: "no_broker_registered",
    });
  });
});

describe("applyCredentialBrokerResolver — PAPERCLIP_REQUIRE_BROKER", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = "1";
    process.env.PAPERCLIP_REQUIRE_BROKER = "1";
  });

  it("throws CredentialBrokerRequiredError when the resolver falls back to env", async () => {
    const logger = fakeLogger();
    await expect(
      applyCredentialBrokerResolver(
        {
          db: fakeDb([{ id: CONNECTION_ID, providerId: "github", brokerTargets: [] }]),
          registry: fakeRegistry(true),
          logger: logger as never,
        },
        {
          companyId: COMPANY_ID,
          envRecord: { GH: oauthBinding },
        },
      ),
    ).rejects.toBeInstanceOf(CredentialBrokerRequiredError);
  });

  it("does NOT throw when the explicit override is set (operator opt-out is respected)", async () => {
    const logger = fakeLogger();
    const result = await applyCredentialBrokerResolver(
      {
        db: fakeDb([{ id: CONNECTION_ID, providerId: "github", brokerTargets: [] }]),
        registry: fakeRegistry(false),
        logger: logger as never,
      },
      {
        companyId: COMPANY_ID,
        envRecord: { GH: oauthBinding },
        explicit: "env",
      },
    );
    expect(result.decision?.reason).toBe("explicit_config");
  });
});

describe("applyCredentialBrokerResolver — broker registered (M2 preview)", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = "1";
  });

  it("decides paperclip-broker when registered, reachable, and provider supports it", async () => {
    registerCredentialBroker(() => stubBroker(true));
    const logger = fakeLogger();
    const result = await applyCredentialBrokerResolver(
      {
        db: fakeDb([{ id: CONNECTION_ID, providerId: "github", brokerTargets: [] }]),
        registry: fakeRegistry(true),
        logger: logger as never,
      },
      {
        companyId: COMPANY_ID,
        envRecord: { GH: oauthBinding },
      },
    );
    expect(result.decision).toEqual({
      mode: "paperclip-broker",
      reason: "broker_available_and_reachable",
    });
    // Non-env decisions don't fire the fallback warn-log.
    expect(logger.warn).not.toHaveBeenCalled();
    // M2 actually mints a session through the registered broker.
    expect(result.brokerSession).toBeDefined();
    expect(result.broker?.id).toBe("stub");
  });

  it("does not call mintSession when the resolver decides byo-broker (operator runs the broker)", async () => {
    registerCredentialBroker(() => stubBroker(true));
    const logger = fakeLogger();
    const result = await applyCredentialBrokerResolver(
      {
        // BYO route — runtime is external; resolver looks for broker_targets
        db: fakeDb([
          {
            id: CONNECTION_ID,
            providerId: "github",
            brokerTargets: [
              {
                id: "t1",
                url: "https://op.example.test/push",
                authTokenSecretId: "secret-uuid",
                addedAt: "2026-05-12T00:00:00Z",
              },
            ],
          },
        ]),
        registry: fakeRegistry(true),
        logger: logger as never,
      },
      {
        companyId: COMPANY_ID,
        envRecord: { GH: oauthBinding },
        executionTargetKind: "external",
      },
    );
    expect(result.decision?.mode).toBe("byo-broker");
    // Paperclip doesn't mint a session for byo — the operator owns the broker.
    expect(result.brokerSession).toBeUndefined();
  });
});
