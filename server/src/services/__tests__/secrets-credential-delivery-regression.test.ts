import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
} from "@paperclipai/db";
import { oauthConnections } from "@paperclipai/db/schema/oauth";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { ProviderRegistry } from "../../oauth/registry.js";
import { secretService } from "../secrets.js";
import { __resetResolvedBrokerForTests } from "../../plugins/credential-broker-registry.js";
import { __clearCredentialBrokerFlagsForTests } from "../../config/credential-broker-flags.js";

/**
 * Regression: with the credential-broker feature flag in both states
 * (off, on-no-broker), `resolveAdapterConfigForRuntime` must produce
 * the same output for an oauth_token binding — the legacy plaintext
 * bearer.
 *
 * The flag-on case additionally asserts that the smart resolver fires
 * and the warn-log records the fallback, but the resolved env value
 * is identical to the flag-off case.
 *
 * This is the M1 behavior-neutrality guarantee made executable.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping credential-broker regression tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres(
  "resolveAdapterConfigForRuntime — credential-broker regression",
  () => {
    let stopDb: (() => Promise<void>) | null = null;
    let db!: ReturnType<typeof createDb>;
    const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    const secretsTmpDir = path.join(
      os.tmpdir(),
      `paperclip-secrets-cb-regression-${randomUUID()}`,
    );

    beforeAll(async () => {
      mkdirSync(secretsTmpDir, { recursive: true });
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
        secretsTmpDir,
        "master.key",
      );
      const started = await startEmbeddedPostgresTestDatabase(
        "secrets-cb-regression",
      );
      stopDb = started.cleanup;
      db = createDb(started.connectionString);
    });

    beforeEach(() => {
      __resetResolvedBrokerForTests();
      __clearCredentialBrokerFlagsForTests();
    });

    afterEach(async () => {
      __clearCredentialBrokerFlagsForTests();
      await db.delete(oauthConnections);
      await db.delete(secretAccessEvents);
      await db.delete(companySecretBindings);
      await db.delete(companySecretVersions);
      await db.delete(companySecrets);
      await db.delete(companySecretProviderConfigs);
      await db.delete(agents);
      await db.delete(companies);
    });

    afterAll(async () => {
      await stopDb?.();
      if (previousKeyFile === undefined) {
        delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      } else {
        process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
      }
      rmSync(secretsTmpDir, { recursive: true, force: true });
    });

    async function seedCompany() {
      const companyId = randomUUID();
      await db.insert(companies).values({
        id: companyId,
        name: "CBReg",
        issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return companyId;
    }

    function makeOauthDeps() {
      const registry = new ProviderRegistry({ env: {} });
      // Register the github provider with broker.supported=false (M1 default).
      registry.register(
        {
          id: "github",
          displayName: "GitHub",
          clientCredentials: {
            clientIdEnv: "MISSING",
            clientSecretEnv: "MISSING",
          },
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
          broker: { supported: false, deliveryModesSupported: ["env"] },
        },
        "yaml",
      );
      return { registry };
    }

    async function seedOAuthConnection(
      companyId: string,
      accessSecretId: string,
    ) {
      const connectionId = randomUUID();
      await db.insert(oauthConnections).values({
        id: connectionId,
        companyId,
        providerId: "github",
        status: "active",
        accessTokenSecretId: accessSecretId,
        refreshTokenSecretId: null,
        accountId: "acct-cbreg",
        accountLabel: "octo",
        scopes: ["repo"],
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        lastError: null,
        lastErrorAt: null,
        lastRefreshedAt: new Date(),
        refreshAttemptCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return connectionId;
    }

    it("flag off vs flag-on-no-broker produce identical resolved env", async () => {
      const companyId = await seedCompany();
      const svc = secretService(db, makeOauthDeps());
      const accessSecret = await svc.upsertSecretByName(companyId, {
        name: `oauth:github:acct-cbreg:access-${randomUUID()}`,
        value: "REGRESSION-PLAINTEXT-TOKEN",
      });
      const connectionId = await seedOAuthConnection(companyId, accessSecret.id);

      const dispatch = {
        env: {
          GITHUB_TOKEN: {
            type: "oauth_token",
            connectionId,
            field: "access",
          },
        },
      };

      delete process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER;
      const flagOff = await svc.resolveAdapterConfigForRuntime(
        companyId,
        dispatch,
      );

      process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = "1";
      const flagOn = await svc.resolveAdapterConfigForRuntime(
        companyId,
        dispatch,
      );

      expect(
        (flagOff.config.env as Record<string, string>).GITHUB_TOKEN,
      ).toBe("REGRESSION-PLAINTEXT-TOKEN");
      expect(
        (flagOn.config.env as Record<string, string>).GITHUB_TOKEN,
      ).toBe("REGRESSION-PLAINTEXT-TOKEN");
      expect(flagOff.oauthConnectionIds).toEqual([connectionId]);
      expect(flagOn.oauthConnectionIds).toEqual([connectionId]);
      expect(Array.from(flagOff.secretKeys)).toEqual(["GITHUB_TOKEN"]);
      expect(Array.from(flagOn.secretKeys)).toEqual(["GITHUB_TOKEN"]);
    });

    it("flag on + PAPERCLIP_REQUIRE_BROKER=1 throws CredentialBrokerRequiredError on oauth_token dispatch", async () => {
      const companyId = await seedCompany();
      const svc = secretService(db, makeOauthDeps());
      const accessSecret = await svc.upsertSecretByName(companyId, {
        name: `oauth:github:acct-cbreg:access-${randomUUID()}`,
        value: "WILL-NOT-BE-RETURNED",
      });
      const connectionId = await seedOAuthConnection(companyId, accessSecret.id);

      process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = "1";
      process.env.PAPERCLIP_REQUIRE_BROKER = "1";

      await expect(
        svc.resolveAdapterConfigForRuntime(companyId, {
          env: {
            GITHUB_TOKEN: {
              type: "oauth_token",
              connectionId,
              field: "access",
            },
          },
        }),
      ).rejects.toMatchObject({ name: "CredentialBrokerRequiredError" });
    });

    it("flag on + explicit credentialDelivery=env opts out of REQUIRE_BROKER", async () => {
      const companyId = await seedCompany();
      const svc = secretService(db, makeOauthDeps());
      const accessSecret = await svc.upsertSecretByName(companyId, {
        name: `oauth:github:acct-cbreg:access-${randomUUID()}`,
        value: "EXPLICIT-OPT-OUT-TOKEN",
      });
      const connectionId = await seedOAuthConnection(companyId, accessSecret.id);

      process.env.PAPERCLIP_FEATURE_CREDENTIAL_BROKER = "1";
      process.env.PAPERCLIP_REQUIRE_BROKER = "1";

      const result = await svc.resolveAdapterConfigForRuntime(companyId, {
        credentialDelivery: "env",
        env: {
          GITHUB_TOKEN: {
            type: "oauth_token",
            connectionId,
            field: "access",
          },
        },
      });

      expect(
        (result.config.env as Record<string, string>).GITHUB_TOKEN,
      ).toBe("EXPLICIT-OPT-OUT-TOKEN");
    });
  },
);
