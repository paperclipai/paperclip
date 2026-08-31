import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  createDb,
  secretAccessEvents,
  userSecretDeclarations,
  userSecretDefinitions,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping dangling user-secret tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// A user can delete a user-secret definition while an agent config still
// references it. Later, a direct-resolution path (Test or save) resolves that
// dangling `user_secret_ref` binding and fails. These tests assert the failure
// names the environment variable, the agent id, and the unresolved definition
// key, and that it never leaks a secret value.
describeEmbeddedPostgres("secretService dangling user_secret_ref resolution", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-dangling-secret-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("dangling-user-secret");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  });

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(userSecretDeclarations);
    await db.delete(companySecretBindings);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(userSecretDefinitions);
    await db.delete(companyMemberships);
    await db.delete(companies);
  });

  afterAll(async () => {
    if (stopDb) await stopDb();
    if (previousKeyFile === undefined) {
      delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    } else {
      process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    }
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  async function seedCompany(name = "Acme") {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  async function seedCompanyMember(companyId: string, userId: string) {
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: userId,
      status: "active",
      membershipRole: "owner",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it("save path (syncEnvBindingsForTarget) names the env variable, the agent id, and the deleted definition key", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });

    // Delete the definition, then keep an agent config that still references it.
    await svc.removeUserSecretDefinition(companyId, definition.id);

    const agentId = randomUUID();
    const envValue = {
      GH_TOKEN: {
        type: "user_secret_ref" as const,
        key: "github_token",
        version: "latest" as const,
        required: true,
      },
    };

    await expect(
      svc.syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: agentId }, envValue),
    ).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("User secret definition not found"),
    });

    // The message must name the env variable, the agent id, and the definition key.
    const error = await svc
      .syncEnvBindingsForTarget(companyId, { targetType: "agent", targetId: agentId }, envValue)
      .catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('environment variable "GH_TOKEN"');
    expect(error.message).toContain(`agent ${agentId}`);
    expect(error.message).toContain('definition key "github_token"');
  });

  it("Test path (resolveUserSecretValue) names the env variable, the agent id, and the deleted definition key without leaking the value", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);
    const definition = await svc.createUserSecretDefinition(companyId, {
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
    });
    const secretValue = "ghp_super_secret_value";
    await svc.createCurrentUserSecretValue(companyId, "user-1", {
      definitionId: definition.id,
      value: secretValue,
    });

    // Delete the definition after the value exists. The binding now dangles.
    await svc.removeUserSecretDefinition(companyId, definition.id);

    const agentId = randomUUID();
    const error = await svc
      .resolveUserSecretValue(
        companyId,
        { definitionKey: "github_token", responsibleUserId: "user-1", required: true },
        {
          consumerType: "agent",
          consumerId: agentId,
          configPath: "env.GH_TOKEN",
          responsibleUserId: "user-1",
        },
      )
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect((error as { status?: number }).status).toBe(404);
    expect(error.message).toContain("User secret definition not found");
    expect(error.message).toContain('environment variable "GH_TOKEN"');
    expect(error.message).toContain(`agent ${agentId}`);
    expect(error.message).toContain('definition key "github_token"');
    // The enriched message must never include the secret value.
    expect(error.message).not.toContain(secretValue);
  });

  it("optional binding still resolves to null when the definition is missing (enrichment keeps the 404 status)", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const resolved = await svc.resolveUserSecretValue(
      companyId,
      { definitionKey: "never_created", responsibleUserId: "user-1", required: false },
      { consumerType: "agent", consumerId: randomUUID(), configPath: "env.GH_TOKEN" },
    );
    expect(resolved).toBeNull();
  });
});
