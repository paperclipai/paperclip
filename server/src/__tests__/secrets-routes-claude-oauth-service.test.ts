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

  // --- the narrow secret-definition helper ------------------------

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

  // --- the owner-bound compare-and-set ----------------------------

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

  it("two concurrent confirmed rotations return one fixed stale 409 and add one version", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const first = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });
    expect(first.latestVersion).toBe(1);

    // Both confirmations read the same latest version 1 and both target the next
    // version 2. The unique index on (secretId, version) lets one insert win. The
    // loser must return the same fixed stale 409, not a raw database error.
    const [a, b] = await Promise.allSettled([
      svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
        sessionId: "session-b",
        mode: "confirmed_rotation",
        value: "rotated-token-b",
        expectedSecretId: first.secretId,
        expectedLatestVersion: 1,
      }),
      svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
        sessionId: "session-c",
        mode: "confirmed_rotation",
        value: "rotated-token-c",
        expectedSecretId: first.secretId,
        expectedLatestVersion: 1,
      }),
    ]);

    const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
    const rejected = [a, b].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser returns the one fixed stale-confirmation 409. The text is the
    // same for every stale race, so it discloses no owner-value state.
    const loser = (rejected[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(HttpError);
    expect((loser as HttpError).status).toBe(409);
    expect((loser as HttpError).message).toContain("The Claude login confirmation is stale");

    const winner = fulfilled[0] as PromiseFulfilledResult<{ latestVersion: number }>;
    expect(winner.value.latestVersion).toBe(2);

    // Only the two winning versions remain. The loser left no extra version row.
    expect(await countVersions(first.secretId)).toBe(2);
  });

  it("normalizes a next-version unique collision to the fixed stale 409 and adds no row", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    const svc = secretService(db);

    const first = await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });
    expect(first.latestVersion).toBe(1);

    // Reproduce the exact race window. A concurrent winner inserted the next
    // version row but has not yet committed its owner-bound compare-and-set, so
    // the latest version still reads 1. A second confirmation that carries the
    // same expected version 1 passes the pre-check, then hits the (secretId,
    // version) unique index on its own insert. That one collision must return the
    // fixed stale 409, not a raw database error.
    await db.insert(companySecretVersions).values({
      secretId: first.secretId,
      version: 2,
      material: {},
      valueSha256: "placeholder-sha256",
      fingerprintSha256: "placeholder-sha256",
      status: "disabled",
    });
    expect(await countVersions(first.secretId)).toBe(2);

    let caught: unknown;
    try {
      await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
        sessionId: "session-b",
        mode: "confirmed_rotation",
        value: "rotated-token-value",
        expectedSecretId: first.secretId,
        expectedLatestVersion: 1,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(409);
    expect((caught as HttpError).message).toContain("The Claude login confirmation is stale");

    // The failed insert added no new row and did not advance the latest version.
    expect(await countVersions(first.secretId)).toBe(2);
    const row = await db
      .select()
      .from(companySecrets)
      .where(eq(companySecrets.id, first.secretId))
      .then((rows) => rows[0]);
    expect(row?.latestVersion).toBe(1);
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

  it("readClaudeOAuthUserSecretStatus returns the secret id and the version for the owner value", async () => {
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

    const status = await svc.readClaudeOAuthUserSecretStatus(companyId, "user-1");
    expect(status).toEqual({ secretId: first.secretId, latestVersion: rotated.latestVersion });
    // The status carries no token value.
    expect(JSON.stringify(status)).not.toContain("oauth-token-value");
    expect(JSON.stringify(status)).not.toContain("rotated-token-value");
  });

  it("readClaudeOAuthUserSecretStatus returns null when the owner has no value", async () => {
    const companyId = await seedCompany();
    await seedCompanyMember(companyId, "user-1");
    await seedCompanyMember(companyId, "user-2");
    const svc = secretService(db);

    // user-1 has a value; user-2 does not. The reader is owner-scoped, so it
    // returns null for user-2 and the metadata for user-1.
    await svc.completeClaudeOAuthUserSecret(companyId, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });

    expect(await svc.readClaudeOAuthUserSecretStatus(companyId, "user-2")).toBeNull();
    // No definition-only or empty company also returns null (the reader never
    // creates the definition).
    const emptyCompany = await seedCompany("Globex");
    await seedCompanyMember(emptyCompany, "user-1");
    expect(await svc.readClaudeOAuthUserSecretStatus(emptyCompany, "user-1")).toBeNull();
  });

  it("readClaudeOAuthUserSecretStatus is owner-scoped and company-scoped", async () => {
    const companyA = await seedCompany("Acme");
    const companyB = await seedCompany("Globex");
    await seedCompanyMember(companyA, "user-1");
    await seedCompanyMember(companyB, "user-1");
    const svc = secretService(db);

    await svc.completeClaudeOAuthUserSecret(companyA, "user-1", {
      sessionId: "session-a",
      mode: "first_write",
      value: "oauth-token-value",
    });

    // The same user in another company has no value there.
    expect(await svc.readClaudeOAuthUserSecretStatus(companyB, "user-1")).toBeNull();
    // Another owner in the same company has no value.
    await seedCompanyMember(companyA, "user-2");
    expect(await svc.readClaudeOAuthUserSecretStatus(companyA, "user-2")).toBeNull();
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
