import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { cleanupExpiredTokens } from "../services/token-cleanup.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping token cleanup tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("token cleanup", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-token-cleanup-");
    db = createDb(tempDb.connectionString);

    // Create better-auth managed tables that don't exist in Paperclip migrations
    await db.execute(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id text PRIMARY KEY,
        token text NOT NULL,
        user_id text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id text PRIMARY KEY,
        email text NOT NULL,
        token text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL
      )
    `);
  }, 20_000);

  afterEach(async () => {
    await db.execute(`DELETE FROM refresh_tokens`);
    await db.execute(`DELETE FROM password_reset_tokens`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("deletes expired refresh tokens", async () => {
    // Insert an expired token
    await db.execute(`
      INSERT INTO refresh_tokens (id, token, user_id, expires_at, created_at)
      VALUES ('rt-1', 'token-1', 'user-1', now() - interval '1 day', now())
    `);

    // Insert a valid token
    await db.execute(`
      INSERT INTO refresh_tokens (id, token, user_id, expires_at, created_at)
      VALUES ('rt-2', 'token-2', 'user-1', now() + interval '1 day', now())
    `);

    await cleanupExpiredTokens(db);

    const remaining = await db.execute(`SELECT id FROM refresh_tokens`);
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as { id: string }).id).toBe("rt-2");
  });

  it("deletes expired password reset tokens", async () => {
    // Insert an expired token
    await db.execute(`
      INSERT INTO password_reset_tokens (id, email, token, expires_at, created_at)
      VALUES ('prt-1', 'user@example.com', 'token-1', now() - interval '1 day', now())
    `);

    // Insert a valid token
    await db.execute(`
      INSERT INTO password_reset_tokens (id, email, token, expires_at, created_at)
      VALUES ('prt-2', 'user@example.com', 'token-2', now() + interval '1 day', now())
    `);

    await cleanupExpiredTokens(db);

    const remaining = await db.execute(`SELECT id FROM password_reset_tokens`);
    expect(remaining).toHaveLength(1);
    expect((remaining[0] as { id: string }).id).toBe("prt-2");
  });
});
