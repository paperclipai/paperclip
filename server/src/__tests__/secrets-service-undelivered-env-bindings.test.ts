import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  companySecretBindings,
  companySecretProviderConfigs,
  companySecretVersions,
  companySecrets,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres undelivered-binding tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * BRO-2367 — the inverse of the config walk. These cover the case a
 * config-walking check structurally cannot see: the binding row is present and
 * the run env is not.
 */
describeEmbeddedPostgres("secretService.collectUndeliveredEnvBindings", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-undelivered-bindings-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("undelivered-bindings");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 20_000);

  afterEach(async () => {
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

  async function seed(configPaths: string[], required = true) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const secrets = secretService(db);
    const secret = await secrets.create(companyId, {
      name: "OPENAI_API_KEY",
      provider: "local_encrypted",
      value: "sk-test-never-logged",
    });
    const agentId = randomUUID();
    const bindings = await db.insert(companySecretBindings).values(
      configPaths.map((configPath) => ({
        companyId,
        secretId: secret.id,
        targetType: "agent" as const,
        targetId: agentId,
        configPath,
        required,
      })),
    ).returning();
    return { companyId, agentId, secretId: secret.id, secrets, bindings };
  }

  it("reports a granted env binding whose key is absent from the run env", async () => {
    const { companyId, agentId, secretId, secrets } = await seed(["env.OPENAI_API_KEY"]);

    const undelivered = await secrets.collectUndeliveredEnvBindings(
      companyId,
      { consumerType: "agent", consumerId: agentId },
      ["PATH", "HOME"],
    );

    expect(undelivered).toEqual([
      expect.objectContaining({
        consumerType: "agent",
        consumerId: agentId,
        configPath: "env.OPENAI_API_KEY",
        envKey: "OPENAI_API_KEY",
        bindingType: "secret_ref",
        secretId,
        secretName: "OPENAI_API_KEY",
        errorCode: "binding_not_delivered",
      }),
    ]);
    // The value is never carried on the finding.
    expect(JSON.stringify(undelivered)).not.toContain("sk-test-never-logged");
  });

  it("reports nothing when the key is present in the run env", async () => {
    const { companyId, agentId, secrets } = await seed(["env.OPENAI_API_KEY"]);

    await expect(
      secrets.collectUndeliveredEnvBindings(
        companyId,
        { consumerType: "agent", consumerId: agentId },
        ["OPENAI_API_KEY"],
      ),
    ).resolves.toEqual([]);
  });

  it("ignores API-only access.<ALIAS> grants, which are fetched over the agent API by design", async () => {
    const { companyId, agentId, secrets } = await seed(["access.OPENAI_API_KEY"]);

    await expect(
      secrets.collectUndeliveredEnvBindings(
        companyId,
        { consumerType: "agent", consumerId: agentId },
        [],
      ),
    ).resolves.toEqual([]);
  });

  it("ignores an optional binding, which the run is allowed to start without", async () => {
    const { companyId, agentId, secrets } = await seed(["env.OPENAI_API_KEY"], false);

    await expect(
      secrets.collectUndeliveredEnvBindings(
        companyId,
        { consumerType: "agent", consumerId: agentId },
        [],
      ),
    ).resolves.toEqual([]);
  });

  it("scopes the check to the consumer it was asked about", async () => {
    const { companyId, secrets } = await seed(["env.OPENAI_API_KEY"]);

    await expect(
      secrets.collectUndeliveredEnvBindings(
        companyId,
        { consumerType: "agent", consumerId: randomUUID() },
        [],
      ),
    ).resolves.toEqual([]);
  });

  it("ignores a binding outside the low-trust boundary, which the run must not receive", async () => {
    const { companyId, agentId, secrets } = await seed(["env.OPENAI_API_KEY"]);

    await expect(
      secrets.collectUndeliveredEnvBindings(
        companyId,
        { consumerType: "agent", consumerId: agentId },
        [],
        { allowedBindingIds: [randomUUID()] },
      ),
    ).resolves.toEqual([]);
  });

  it("still reports a binding inside the low-trust boundary", async () => {
    const { companyId, agentId, secrets, bindings } = await seed(["env.OPENAI_API_KEY"]);

    await expect(
      secrets.collectUndeliveredEnvBindings(
        companyId,
        { consumerType: "agent", consumerId: agentId },
        [],
        { allowedBindingIds: bindings.map((binding) => binding.id) },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ configPath: "env.OPENAI_API_KEY", errorCode: "binding_not_delivered" }),
    ]);
  });

  it("requires every binding when no boundary is in effect", async () => {
    const { companyId, agentId, secrets } = await seed(["env.OPENAI_API_KEY"]);

    await expect(
      secrets.collectUndeliveredEnvBindings(
        companyId,
        { consumerType: "agent", consumerId: agentId },
        [],
        { allowedBindingIds: null },
      ),
    ).resolves.toEqual([
      expect.objectContaining({ configPath: "env.OPENAI_API_KEY" }),
    ]);
  });
});
