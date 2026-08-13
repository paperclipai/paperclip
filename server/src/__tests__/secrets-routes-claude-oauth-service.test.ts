// The narrow Claude Code OAuth secret helper and the owner-bound compare-and-set
// live in the secret service, not in a route. These tests exercise the real
// service against an embedded Postgres database, so the partial unique index,
// the expected-version predicate, and the session-id idempotency all run against
// real constraints. The route-level tests stay in secrets-routes.test.ts, which
// mocks the service and cannot exercise the database behavior.

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
import { and, eq } from "drizzle-orm";
import { HttpError } from "../errors.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping Claude OAuth secret service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// The fixed key the narrow helper owns. A caller never selects it.
const CLAUDE_KEY = "CLAUDE_CODE_OAUTH_TOKEN";
const CLAUDE_NAME = "Claude Code OAuth token";

describeEmbeddedPostgres("secretService Claude Code OAuth helper and compare-and-set", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-claude-oauth-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    const started = await startEmbeddedPostgresTestDatabase("claude-oauth-secrets");
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

  async function countVersions(secretId: string) {
    const rows = await db
      .select()
      .from(companySecretVersions)
      .where(eq(companySecretVersions.secretId, secretId));
    return rows.length;
  }

  // --- Control 5: the narrow secret-definition helper ------------------------

  it("creates the fixed Claude OAuth definition with the compile-time key and fixed properties", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const definition = await svc.ensureClaudeOAuthUserSecretDefinition(companyId, { userId: "user-1", agentId: null });

    expect(definition.key).toBe(CLAUDE_KEY);
    expect(definition.name).toBe(CLAUDE_NAME);
    expect(definition.provider).toBe("local_encrypted");
    expect(definition.managedMode).toBe("paperclip_managed");
    expect(definition.status).toBe("active");
  });

  it("reuses an exact compatible definition without a second row", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const first = await svc.ensureClaudeOAuthUserSecretDefinition(companyId);
    const second = await svc.ensureClaudeOAuthUserSecretDefinition(companyId);

    expect(second.id).toBe(first.id);
    const rows = await db
      .select()
      .from(userSecretDefinitions)
      .where(eq(userSecretDefinitions.companyId, companyId));
    expect(rows).toHaveLength(1);
  });

  it("rejects a conflicting definition with 409 and does not mutate it", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    // A pre-existing definition holds the fixed key but a different name. It is
    // not the exact fixed shape, so the helper must reject it and leave it alone.
    const conflicting = await svc.createUserSecretDefinition(companyId, {
      key: CLAUDE_KEY,
      name: "Some other Claude token",
      provider: "local_encrypted",
    });

    await expect(svc.ensureClaudeOAuthUserSecretDefinition(companyId)).rejects.toMatchObject({ status: 409 });

    const row = await db
      .select()
      .from(userSecretDefinitions)
      .where(eq(userSecretDefinitions.id, conflicting.id))
      .then((rows) => rows[0]);
    expect(row?.name).toBe("Some other Claude token");
  });

  // --- Control 1: the owner-bound compare-and-set ----------------------------

  it("first_write creates the owner value and stores the session id", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const result = await svc.completeClaudeOAuthUserSecret(
      companyId,
      "user-1",
      { sessionId: "session-a", mode: "first_write", value: "oauth-token-value" },
      { userId: "user-1", agentId: null },
    );

    expect(result.secretId).toBeTruthy();
    expect(result.latestVersion).toBe(1);
    expect(await countVersions(result.secretId)).toBe(1);
  });

  it("first_write conflicts with 409 when a different session already wrote the owner value", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });

    await expect(
      svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
        sessionId: "session-b",
        mode: "first_write",
        value: "another-token-value",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("first_write is idempotent for the same session id and creates no new version", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const first = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });
    const repeat = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });

    expect(repeat.secretId).toBe(first.secretId);
    expect(repeat.latestVersion).toBe(1);
    expect(await countVersions(first.secretId)).toBe(1);
  });

  it("confirmed_rotation requires expectedSecretId and expectedLatestVersion", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });

    await expect(
      svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
        sessionId: "session-b",
        mode: "confirmed_rotation",
        value: "rotated-token-value",
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it("confirmed_rotation rotates to the next version when the expected version matches", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const first = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });

    const rotated = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-b",
      mode: "confirmed_rotation",
      value: "rotated-token-value",
      expectedSecretId: first.secretId,
      expectedLatestVersion: first.latestVersion,
    });

    expect(rotated.secretId).toBe(first.secretId);
    expect(rotated.latestVersion).toBe(2);
    expect(await countVersions(first.secretId)).toBe(2);
  });

  it("confirmed_rotation returns a fixed stale-confirmation 409 for a wrong expected version", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const first = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });
    // A first confirmed rotation moves the value to version 2.
    await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-b",
      mode: "confirmed_rotation",
      value: "rotated-token-value",
      expectedSecretId: first.secretId,
      expectedLatestVersion: 1,
    });

    // A later confirmation still carries the stale version 1 and must conflict.
    await expect(
      svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
        sessionId: "session-c",
        mode: "confirmed_rotation",
        value: "third-token-value",
        expectedSecretId: first.secretId,
        expectedLatestVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // The stale confirmation created no new version.
    expect(await countVersions(first.secretId)).toBe(2);
  });

  it("confirmed_rotation is idempotent for the same session id and creates no new version", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const first = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });
    const rotated = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-b",
      mode: "confirmed_rotation",
      value: "rotated-token-value",
      expectedSecretId: first.secretId,
      expectedLatestVersion: 1,
    });

    const repeat = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-b",
      mode: "confirmed_rotation",
      value: "rotated-token-value",
      expectedSecretId: first.secretId,
      expectedLatestVersion: 1,
    });

    expect(repeat.secretId).toBe(rotated.secretId);
    expect(repeat.latestVersion).toBe(2);
    expect(await countVersions(first.secretId)).toBe(2);
  });

  it("two concurrent first writes leave exactly one owner value through the partial unique index", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const [a, b] = await Promise.allSettled([
      svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
        sessionId: "session-a",
        mode: "first_write",
        value: "token-a",
      }),
      svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
        sessionId: "session-b",
        mode: "first_write",
        value: "token-b",
      }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const values = await db
      .select()
      .from(companySecrets)
      .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.scope, "user")));
    expect(values).toHaveLength(1);
  });

  it("confirmed_rotation on a value from another owner returns not-found", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    await seedCompanyMember(companyId, "user-2");
    const svc = secretService(db);

    const owned = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });

    // user-2 points at user-1's secret id. The owner-scoped lookup fails closed.
    await expect(
      svc.completeClaudeOAuthUserSecret(companyId, "user-2", {
        sessionId: "session-b",
        mode: "confirmed_rotation",
        value: "rotated-token-value",
        expectedSecretId: owned.secretId,
        expectedLatestVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("confirmed_rotation on a value from another company returns not-found", async () => {
    const companyA = await seedCompany("Acme");
    const companyB = await seedCompany("Globex");
    await seedCompanyMember(companyA, "user-1");
    await seedCompanyMember(companyB, "user-1");
    const svc = secretService(db);

    const owned = await svc.completeClaudeOAuthUserSecret(companyA, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });

    await expect(
      svc.completeClaudeOAuthUserSecret(companyB, "user-1", {
        sessionId: "session-b",
        mode: "confirmed_rotation",
        value: "rotated-token-value",
        expectedSecretId: owned.secretId,
        expectedLatestVersion: 1,
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("keeps the token out of every activity detail", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);
    const token = "super-secret-oauth-token";

    const first = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: token,
    });
    await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-b",
      mode: "confirmed_rotation",
      value: "rotated-secret-oauth-token",
      expectedSecretId: first.secretId,
      expectedLatestVersion: 1,
    });

    const activity = await db.select().from(activityLog);
    expect(JSON.stringify(activity)).not.toContain(token);
    expect(JSON.stringify(activity)).not.toContain("rotated-secret-oauth-token");
  });
});
