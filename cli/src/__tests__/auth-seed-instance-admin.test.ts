import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { authUsers, createDb, instanceUserRoles } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  ensureInstanceAdmin,
  resolveSeedPrincipal,
  type SeedInstanceAdminPrincipal,
} from "../commands/auth-seed-instance-admin.js";

describe("resolveSeedPrincipal", () => {
  it("falls back to the built-in defaults when no env vars are set", () => {
    expect(resolveSeedPrincipal({})).toEqual({
      userId: "platform-admin",
      email: "platform-admin@paperclip.local",
      name: "Platform Admin",
    });
  });

  it("reads overrides from the PAPERCLIP_SEED_ADMIN_* env vars", () => {
    expect(
      resolveSeedPrincipal({
        PAPERCLIP_SEED_ADMIN_USER_ID: "custom-admin",
        PAPERCLIP_SEED_ADMIN_EMAIL: "ops@example.com",
        PAPERCLIP_SEED_ADMIN_NAME: "Ops Team",
      }),
    ).toEqual({
      userId: "custom-admin",
      email: "ops@example.com",
      name: "Ops Team",
    });
  });

  it("treats blank/whitespace env values as unset and uses defaults", () => {
    expect(
      resolveSeedPrincipal({
        PAPERCLIP_SEED_ADMIN_USER_ID: "   ",
        PAPERCLIP_SEED_ADMIN_EMAIL: "",
      }),
    ).toEqual({
      userId: "platform-admin",
      email: "platform-admin@paperclip.local",
      name: "Platform Admin",
    });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres seed-instance-admin tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ensureInstanceAdmin", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const principal: SeedInstanceAdminPrincipal = {
    userId: "platform-admin",
    email: "platform-admin@paperclip.local",
    name: "Platform Admin",
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-seed-admin-cli-db-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function countAdminRoles(userId: string): Promise<number> {
    const rows = await db
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, userId), eq(instanceUserRoles.role, "instance_admin")));
    return rows.length;
  }

  it("creates the user and instance_admin role on first run", async () => {
    const result = await ensureInstanceAdmin(db, principal);

    expect(result).toEqual({ createdUser: true, createdRole: true });

    const users = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, principal.userId));
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe(principal.email);
    expect(users[0]?.name).toBe(principal.name);
    expect(users[0]?.emailVerified).toBe(true);
    expect(users[0]?.image).toBeNull();

    expect(await countAdminRoles(principal.userId)).toBe(1);
  });

  it("is idempotent: running twice yields exactly one instance_admin row", async () => {
    const first = await ensureInstanceAdmin(db, principal);
    const second = await ensureInstanceAdmin(db, principal);

    expect(first).toEqual({ createdUser: true, createdRole: true });
    expect(second).toEqual({ createdUser: false, createdRole: false });

    const users = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, principal.userId));
    expect(users).toHaveLength(1);

    expect(await countAdminRoles(principal.userId)).toBe(1);
  });

  it("never throws when run twice (DB-level ON CONFLICT DO NOTHING)", async () => {
    await expect(ensureInstanceAdmin(db, principal)).resolves.toBeDefined();
    await expect(ensureInstanceAdmin(db, principal)).resolves.toBeDefined();
  });

  it("is race-safe: two near-concurrent seeds yield exactly one admin", async () => {
    // Simulates two automation processes (e.g. per-replica init containers
    // or a retried deploy hook) running the seed at the same time. Without
    // ON CONFLICT DO NOTHING the loser of the insert race throws a
    // duplicate-key error and fails its run.
    const [a, b] = await Promise.all([
      ensureInstanceAdmin(db, principal),
      ensureInstanceAdmin(db, principal),
    ]);

    // The created* flags come from RETURNING on the conflict-safe inserts,
    // so exactly one racer reports having inserted each row — the loser's
    // ON CONFLICT DO NOTHING no-op must not be reported as a creation.
    expect([a.createdUser, b.createdUser].filter(Boolean)).toHaveLength(1);
    expect([a.createdRole, b.createdRole].filter(Boolean)).toHaveLength(1);

    const users = await db
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, principal.userId));
    expect(users).toHaveLength(1);

    expect(await countAdminRoles(principal.userId)).toBe(1);
  });

  it("backfills the role when the user already exists but has no role", async () => {
    const now = new Date();
    await db.insert(authUsers).values({
      id: principal.userId,
      name: principal.name,
      email: principal.email,
      emailVerified: true,
      image: null,
      createdAt: now,
      updatedAt: now,
    });

    const result = await ensureInstanceAdmin(db, principal);
    expect(result).toEqual({ createdUser: false, createdRole: true });
    expect(await countAdminRoles(principal.userId)).toBe(1);
  });
});
