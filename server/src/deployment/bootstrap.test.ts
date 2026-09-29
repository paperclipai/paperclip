import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { authAccounts, authSessions, authUsers, instanceUserRoles, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { createBetterAuthInstance } from "../auth/better-auth.js";
import { bootstrapOperator } from "./bootstrap.js";

describe("pre-listen operator bootstrap", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  const config = { ...loadConfig(), deploymentMode: "authenticated" as const,
    authBaseUrlMode: "explicit" as const, authPublicBaseUrl: "http://localhost:3100", authDisableSignUp: true };
  const input = { email: "operator@example.test", name: "Operator", passwordFile: "" };
  beforeAll(async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "bootstrap-fixture-signing-secret-at-least-32-characters");
    database = await startEmbeddedPostgresTestDatabase("paperclip-bootstrap-");
    db = createDb(database.connectionString);
    root = await mkdtemp(join(tmpdir(), "paperclip-bootstrap-"));
    input.passwordFile = join(root, "password");
    await writeFile(input.passwordFile, "fixture-only-operator-password", { mode: 0o600 });
  }, 90_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });
  const snapshot = async () => ({ users: await db.select().from(authUsers), accounts: await db.select().from(authAccounts),
    roles: await db.select().from(instanceUserRoles), sessions: await db.select().from(authSessions) });

  it("rolls back account creation if the administrator claim fails", async () => {
    await db.execute(sql`create function fail_bootstrap_claim() returns trigger language plpgsql as $$ begin raise exception 'injected claim failure'; end; $$`);
    await db.execute(sql`create trigger fail_bootstrap_claim before insert on instance_user_roles for each row execute function fail_bootstrap_claim()`);
    const before = await snapshot();
    try {
      await expect(bootstrapOperator(db, config, input)).rejects.toThrow();
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.execute(sql`drop trigger fail_bootstrap_claim on instance_user_roles`);
      await db.execute(sql`drop function fail_bootstrap_claim()`);
    }
  }, 30_000);

  it("bootstraps once without sessions and preserves credentials on concurrent reapply", async () => {
    const id = await bootstrapOperator(db, config, input);
    expect(await db.select().from(instanceUserRoles)).toMatchObject([{ userId: id, role: "instance_admin" }]);
    expect(await db.select().from(authSessions)).toHaveLength(0);
    const before = await snapshot();
    await writeFile(input.passwordFile, "different-fixture-only-password", { mode: 0o600 });
    expect(await Promise.all([bootstrapOperator(db, config, input), bootstrapOperator(db, config, input)])).toEqual([id, id]);
    expect(await snapshot()).toEqual(before);
    const auth = createBetterAuthInstance(db, config, []);
    const request = (endpoint: string, body: unknown) => auth.handler(new Request(`${config.authPublicBaseUrl}/api/auth/${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    expect((await request("sign-in/email", { email: input.email, password: "fixture-only-operator-password" })).status).toBe(200);
    expect((await request("sign-up/email", { email: "outsider@example.test", name: "Outsider", password: "fixture-only-operator-password" })).ok).toBe(false);
    expect(await db.select().from(authUsers)).toHaveLength(1);
  }, 30_000);

  it("refuses to replace an administrator or adopt a non-admin account", async () => {
    await db.insert(authUsers).values({ id: "non-admin", name: "Existing", email: "existing@example.test",
      createdAt: new Date(), updatedAt: new Date() });
    const before = await snapshot();
    await expect(bootstrapOperator(db, config, { ...input, email: "other@example.test" })).rejects.toThrow("replace");
    await expect(bootstrapOperator(db, config, { ...input, email: "existing@example.test" })).rejects.toThrow("non-administrator");
    expect(await snapshot()).toEqual(before);
    await db.delete(authUsers).where(eq(authUsers.id, "non-admin"));
  });
});
