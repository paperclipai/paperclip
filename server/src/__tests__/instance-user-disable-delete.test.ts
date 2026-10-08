/**
 * Instance admins disabling, re-enabling and deleting user accounts, driven
 * through the real Better Auth mount, the real actor middleware and the real
 * access routes against a migrated Postgres. The point is to prove the block
 * holds on every credential the user can still hold, not only at sign-in.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import WebSocket from "ws";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  authAccounts,
  authSessions,
  authUsers,
  boardApiKeys,
  companies,
  companyMemberships,
  createDb,
  instanceUserRoles,
  invites,
  joinRequests,
  userDisablements,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

vi.hoisted(() => {
  process.env.PAPERCLIP_HOME = "/tmp/paperclip-test-home";
  process.env.PAPERCLIP_INSTANCE_ID = "vitest";
  process.env.PAPERCLIP_LOG_DIR = "/tmp/paperclip-test-home/logs";
  process.env.PAPERCLIP_IN_WORKTREE = "false";
});

const ORIGIN = "http://127.0.0.1:41998";
const PASSWORD = "correct-horse-battery-staple";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

function sessionCookieHeader(response: request.Response): string {
  const raw = response.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return cookies
    .filter((cookie) => cookie.includes("session_token"))
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

describeEmbeddedPostgres("instance admin user disable and delete", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: Db;
  let app!: express.Express;
  let server: Server | null = null;
  const originalEnv = {
    secret: process.env.BETTER_AUTH_SECRET,
    rateLimit: process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED,
  };

  async function signUp(label: string) {
    const email = `${label}-${randomUUID()}@example.com`;
    const response = await request(app)
      .post("/api/auth/sign-up/email")
      .set("origin", ORIGIN)
      .send({ email, password: PASSWORD, name: label });
    expect(response.status).toBe(200);
    return { id: response.body.user.id as string, email, cookie: sessionCookieHeader(response) };
  }

  async function signIn(email: string) {
    return request(app)
      .post("/api/auth/sign-in/email")
      .set("origin", ORIGIN)
      .send({ email, password: PASSWORD });
  }

  async function makeAdmin(userId: string) {
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
  }

  async function createCompany() {
    return db
      .insert(companies)
      .values({
        name: `Disable ${randomUUID()}`,
        issuePrefix: `DU${randomUUID().replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  async function createPendingJoinRequest(companyId: string, applicant: { id: string; email: string }) {
    const [invite] = await db
      .insert(invites)
      .values({ companyId, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) })
      .returning();
    return db
      .insert(joinRequests)
      .values({
        inviteId: invite!.id,
        companyId,
        requestType: "human",
        requestIp: "127.0.0.1",
        requestingUserId: applicant.id,
        requestEmailSnapshot: applicant.email,
      })
      .returning()
      .then((rows) => rows[0]!);
  }

  /** Waits until another connection is blocked waiting for a row lock. */
  async function waitForAccountLockWaiter() {
    await vi.waitFor(async () => {
      const [row] = await db.execute<{ count: number }>(sql`
        select count(*)::int as count from pg_locks
        where not granted and locktype = 'transactionid'
      `);
      expect(row!.count).toBeGreaterThan(0);
    }, { timeout: 10_000, interval: 20 });
  }

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET = "better-auth-secret-for-user-disable-tests";
    process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = "false";

    database = await startEmbeddedPostgresTestDatabase("paperclip-user-disable-");
    db = createDb(database.connectionString);

    const {
      createBetterAuthHandler,
      createBetterAuthInstance,
      resolveBetterAuthSession,
      resolveBetterAuthSessionFromHeaders,
    } = await import("../auth/better-auth.js");
    const { actorMiddleware } = await import("../middleware/auth.js");
    const { accessRoutes } = await import("../routes/access.js");
    const { errorHandler } = await import("../middleware/index.js");

    const auth = createBetterAuthInstance(
      db,
      {
        deploymentMode: "authenticated",
        deploymentExposure: "private",
        authBaseUrlMode: "explicit",
        authPublicBaseUrl: ORIGIN,
        authDisableSignUp: false,
        allowedHostnames: ["127.0.0.1"],
        port: 41998,
      } as never,
      [ORIGIN],
    );
    app = express();
    app.all("/api/auth/{*authPath}", createBetterAuthHandler(auth));
    app.use(express.json());
    app.use(actorMiddleware(db, {
      deploymentMode: "authenticated",
      resolveSession: (req) => resolveBetterAuthSession(auth, req),
    }));
    app.use("/api", accessRoutes(db, {
      deploymentMode: "authenticated",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
    }));
    app.use(errorHandler);

    const { setupLiveEventsWebSocketServer } = await import("../realtime/live-events-ws.js");
    server = createServer(app);
    setupLiveEventsWebSocketServer(server, db, {
      deploymentMode: "authenticated",
      resolveSessionFromHeaders: (headers) => resolveBetterAuthSessionFromHeaders(auth, headers),
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    await database?.cleanup();
    if (originalEnv.secret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = originalEnv.secret;
    if (originalEnv.rateLimit === undefined) delete process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED;
    else process.env.PAPERCLIP_AUTH_RATE_LIMIT_ENABLED = originalEnv.rateLimit;
  });

  it("disables a user everywhere and restores access when re-enabled", async () => {
    const admin = await signUp("admin");
    await makeAdmin(admin.id);
    const member = await signUp("member");
    const { boardAuthService } = await import("../services/board-auth.js");
    const boardKey = await boardAuthService(db).createNamedBoardApiKey({ userId: member.id, name: "cli" });

    // Both credentials work before the block.
    expect((await request(app).get("/api/cli-auth/me").set("cookie", member.cookie)).status).toBe(200);
    expect(
      (await request(app).get("/api/cli-auth/me").set("authorization", `Bearer ${boardKey.token}`)).status,
    ).toBe(200);

    // Only instance admins may disable.
    const forbidden = await request(app)
      .post(`/api/admin/users/${admin.id}/disable`)
      .set("cookie", member.cookie)
      .send({});
    expect(forbidden.status).toBe(403);

    const disabled = await request(app)
      .post(`/api/admin/users/${member.id}/disable`)
      .set("cookie", admin.cookie)
      .send({ reason: "  Spam registrations  " });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ userId: member.id, status: "disabled", reason: "Spam registrations" });
    expect(disabled.body.revokedSessionCount).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, member.id))).toHaveLength(0);
    const [record] = await db.select().from(userDisablements).where(eq(userDisablements.userId, member.id));
    expect(record).toMatchObject({ disabledByUserId: admin.id, reason: "Spam registrations", enabledAt: null });

    // The session that was signed in before the block no longer authenticates.
    expect((await request(app).get("/api/cli-auth/me").set("cookie", member.cookie)).status).toBe(401);
    // Board API keys stop resolving while the block is active.
    const keyRequest = await request(app)
      .get("/api/cli-auth/me")
      .set("authorization", `Bearer ${boardKey.token}`);
    expect(keyRequest.status).toBe(401);
    expect(keyRequest.body.error).toBe("User account is disabled");

    // Signing in again is refused before a session exists.
    const blockedSignIn = await signIn(member.email);
    expect(blockedSignIn.status).toBe(403);
    expect(blockedSignIn.body?.code).toBe("USER_DISABLED");
    expect(sessionCookieHeader(blockedSignIn)).toBe("");
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, member.id))).toHaveLength(0);

    const directory = await request(app).get("/api/admin/users").set("cookie", admin.cookie);
    expect(directory.status).toBe(200);
    expect(directory.body.find((entry: { id: string }) => entry.id === member.id)).toMatchObject({
      status: "disabled",
      disabledReason: "Spam registrations",
      disabledByUserId: admin.id,
    });
    expect(directory.body.find((entry: { id: string }) => entry.id === admin.id)).toMatchObject({
      status: "active",
      disabledAt: null,
    });

    const enabled = await request(app)
      .post(`/api/admin/users/${member.id}/enable`)
      .set("cookie", admin.cookie)
      .send({});
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ userId: member.id, status: "active", wasDisabled: true });
    const [closed] = await db.select().from(userDisablements).where(eq(userDisablements.userId, member.id));
    expect(closed?.enabledByUserId).toBe(admin.id);
    expect(closed?.enabledAt).toBeInstanceOf(Date);

    const signInAgain = await signIn(member.email);
    expect(signInAgain.status).toBe(200);
    const freshCookie = sessionCookieHeader(signInAgain);
    expect((await request(app).get("/api/cli-auth/me").set("cookie", freshCookie)).status).toBe(200);
    expect(
      (await request(app).get("/api/cli-auth/me").set("authorization", `Bearer ${boardKey.token}`)).status,
    ).toBe(200);
  });

  it("closes an open live-events socket and refuses new ones while disabled", async () => {
    const admin = await signUp("ws-admin");
    await makeAdmin(admin.id);
    const member = await signUp("ws-member");
    const company = await createCompany();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.id,
      status: "active",
      membershipRole: "operator",
    });
    const { port } = server!.address() as AddressInfo;
    const url = `ws://127.0.0.1:${port}/api/companies/${company.id}/events/ws`;
    const connect = () => new WebSocket(url, { headers: { cookie: member.cookie, origin: ORIGIN } });

    const socket = connect();
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) => socket.once("close", (code) => resolve(code)));

    expect(
      (await request(app).post(`/api/admin/users/${member.id}/disable`).set("cookie", admin.cookie).send({})).status,
    ).toBe(200);
    const { publishLiveEvent } = await import("../services/live-events.js");
    publishLiveEvent({ companyId: company.id, type: "activity.logged", payload: { action: "probe" } });
    expect(await closed).toBe(1008);

    // The session cookie was revoked, so a reconnect is refused at upgrade.
    const retry = connect();
    const status = await new Promise<number | null>((resolve) => {
      retry.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? null));
      retry.once("open", () => resolve(null));
      retry.once("error", () => resolve(null));
    });
    retry.terminate();
    expect(status).toBe(403);
  });

  it("refuses to let an admin disable or delete their own account", async () => {
    const admin = await signUp("self");
    await makeAdmin(admin.id);

    const disable = await request(app)
      .post(`/api/admin/users/${admin.id}/disable`)
      .set("cookie", admin.cookie)
      .send({});
    expect(disable.status).toBe(409);
    expect(disable.body.code).toBe("instance_user_self_action");

    const remove = await request(app).delete(`/api/admin/users/${admin.id}`).set("cookie", admin.cookie);
    expect(remove.status).toBe(409);
    expect(remove.body.code).toBe("instance_user_self_action");
  });

  it("keeps at least one active instance admin", async () => {
    await db.delete(instanceUserRoles);
    const first = await signUp("first-admin");
    const second = await signUp("second-admin");
    await makeAdmin(first.id);
    await makeAdmin(second.id);

    // Disabling another admin is fine while the actor remains an active admin.
    expect(
      (await request(app).post(`/api/admin/users/${second.id}/disable`).set("cookie", first.cookie).send({})).status,
    ).toBe(200);

    // With the other admin disabled, the first admin is the last active one.
    const demote = await request(app)
      .post(`/api/admin/users/${first.id}/demote-instance-admin`)
      .set("cookie", first.cookie)
      .send({});
    expect(demote.status).toBe(409);
    expect(demote.body.code).toBe("instance_user_last_admin");

    // Deleting an admin requires removing the role first.
    const remove = await request(app).delete(`/api/admin/users/${second.id}`).set("cookie", first.cookie);
    expect(remove.status).toBe(409);
    expect(remove.body.code).toBe("instance_user_is_admin");

    // Once the second admin is back, demoting either one leaves an admin behind.
    expect(
      (await request(app).post(`/api/admin/users/${second.id}/enable`).set("cookie", first.cookie).send({})).status,
    ).toBe(200);
    expect(
      (await request(app)
        .post(`/api/admin/users/${second.id}/demote-instance-admin`)
        .set("cookie", first.cookie)
        .send({})).status,
    ).toBe(200);
  });

  it("deletes an account without company history and cleans up what it owned", async () => {
    const admin = await signUp("deleter");
    await makeAdmin(admin.id);
    const applicant = await signUp("applicant");
    const { boardAuthService } = await import("../services/board-auth.js");
    await boardAuthService(db).createNamedBoardApiKey({ userId: applicant.id, name: "cli" });

    // A pending request to join a company, as left behind by an invite link.
    const company = await createCompany();
    const [invite] = await db
      .insert(invites)
      .values({ companyId: company.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) })
      .returning();
    const [joinRequest] = await db
      .insert(joinRequests)
      .values({
        inviteId: invite!.id,
        companyId: company.id,
        requestType: "human",
        requestIp: "127.0.0.1",
        requestingUserId: applicant.id,
        requestEmailSnapshot: applicant.email,
      })
      .returning();
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "user",
      actorId: applicant.id,
      action: "join.requested",
      entityType: "join_request",
      entityId: joinRequest!.id,
    });

    const remove = await request(app).delete(`/api/admin/users/${applicant.id}`).set("cookie", admin.cookie);
    expect(remove.status).toBe(200);
    expect(remove.body).toEqual({ userId: applicant.id, deleted: true, rejectedJoinRequestCount: 1 });

    expect(await db.select().from(authUsers).where(eq(authUsers.id, applicant.id))).toHaveLength(0);
    expect(await db.select().from(authAccounts).where(eq(authAccounts.userId, applicant.id))).toHaveLength(0);
    expect(await db.select().from(authSessions).where(eq(authSessions.userId, applicant.id))).toHaveLength(0);
    expect(await db.select().from(boardApiKeys).where(eq(boardApiKeys.userId, applicant.id))).toHaveLength(0);
    const [rejected] = await db.select().from(joinRequests).where(eq(joinRequests.id, joinRequest!.id));
    expect(rejected).toMatchObject({ status: "rejected", rejectedByUserId: admin.id });
    const rejectionActivity = await db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.entityId, joinRequest!.id), eq(activityLog.action, "join.rejected")));
    expect(rejectionActivity).toHaveLength(1);
    expect(rejectionActivity[0]?.details).toMatchObject({ reason: "user_deleted" });

    // The deleted account cannot sign in again.
    expect((await signIn(applicant.email)).status).toBe(401);
    expect(
      (await request(app).delete(`/api/admin/users/${applicant.id}`).set("cookie", admin.cookie)).status,
    ).toBe(404);
  });

  it("refuses to delete an account with company history", async () => {
    const admin = await signUp("historian");
    await makeAdmin(admin.id);

    const member = await signUp("archived-member");
    const company = await createCompany();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: member.id,
      status: "archived",
      membershipRole: "operator",
    });
    const withMembership = await request(app).delete(`/api/admin/users/${member.id}`).set("cookie", admin.cookie);
    expect(withMembership.status).toBe(409);
    expect(withMembership.body.code).toBe("instance_user_has_history");
    expect(withMembership.body.error).toContain("Disable the account instead");

    // Work done without a membership (a former instance admin) also counts.
    const formerAdmin = await signUp("former-admin");
    await db.insert(activityLog).values({
      companyId: company.id,
      actorType: "user",
      actorId: formerAdmin.id,
      action: "issue.created",
      entityType: "issue",
      entityId: randomUUID(),
    });
    const withActivity = await request(app).delete(`/api/admin/users/${formerAdmin.id}`).set("cookie", admin.cookie);
    expect(withActivity.status).toBe(409);
    expect(withActivity.body.code).toBe("instance_user_has_history");

    expect(await db.select().from(authUsers).where(eq(authUsers.id, member.id))).toHaveLength(1);
    expect(await db.select().from(authUsers).where(eq(authUsers.id, formerAdmin.id))).toHaveLength(1);
  });

  it("orders join approval and account deletion on the account lock", async () => {
    const { instanceUserService, lockUserAccount } = await import("../services/instance-users.js");
    const admin = await signUp("approver");
    await makeAdmin(admin.id);
    const company = await createCompany();
    await db.insert(companyMemberships).values({
      companyId: company.id,
      principalType: "user",
      principalId: admin.id,
      status: "active",
      membershipRole: "owner",
    });

    // Deletion holds the account first: the approval waits, then finds the
    // account gone and creates no membership.
    const deleted = await signUp("deleted-applicant");
    const deletedRequest = await createPendingJoinRequest(company.id, deleted);
    let approval!: Promise<request.Response>;
    await db.transaction(async (tx) => {
      await lockUserAccount(tx, deleted.id, "update");
      approval = request(app)
        .post(`/api/companies/${company.id}/join-requests/${deletedRequest.id}/approve`)
        .set("cookie", admin.cookie)
        .then((response) => response);
      await waitForAccountLockWaiter();
      await instanceUserService(tx as unknown as Db).deleteUser({ userId: deleted.id, actorUserId: admin.id });
    });
    const refused = await approval;
    expect(refused.status).toBe(409);
    expect(
      await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, deleted.id)),
    ).toHaveLength(0);
    const [closed] = await db.select().from(joinRequests).where(eq(joinRequests.id, deletedRequest.id));
    expect(closed?.status).toBe("rejected");

    // Approval holds the account first: the deletion waits, then sees the new
    // membership and refuses.
    const approved = await signUp("approved-applicant");
    let deletion!: Promise<unknown>;
    await db.transaction(async (tx) => {
      await lockUserAccount(tx, approved.id, "key share");
      deletion = instanceUserService(db)
        .deleteUser({ userId: approved.id, actorUserId: admin.id })
        .then(() => null, (error: unknown) => error);
      await waitForAccountLockWaiter();
      await tx.insert(companyMemberships).values({
        companyId: company.id,
        principalType: "user",
        principalId: approved.id,
        status: "active",
        membershipRole: "operator",
      });
    });
    expect(await deletion).toMatchObject({ status: 409, details: { code: "instance_user_has_history" } });
    expect(await db.select().from(authUsers).where(eq(authUsers.id, approved.id))).toHaveLength(1);

    // Without a concurrent deletion the approval goes through as before.
    const joiner = await signUp("joiner");
    const joinerRequest = await createPendingJoinRequest(company.id, joiner);
    const accepted = await request(app)
      .post(`/api/companies/${company.id}/join-requests/${joinerRequest.id}/approve`)
      .set("cookie", admin.cookie);
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ status: "approved", approvedByUserId: admin.id });
    expect(
      await db.select().from(companyMemberships).where(eq(companyMemberships.principalId, joiner.id)),
    ).toMatchObject([{ status: "active" }]);
  });

  it("returns the fresh block when an enable lands while disabling an already disabled user", async () => {
    const { instanceUserService, lockUserAccount } = await import("../services/instance-users.js");
    const admin = await signUp("racer");
    await makeAdmin(admin.id);
    const target = await signUp("raced");
    const service = instanceUserService(db);
    await service.disableUser({ userId: target.id, actorUserId: admin.id, reason: "first" });

    let disabling!: Promise<Awaited<ReturnType<typeof service.disableUser>>>;
    await db.transaction(async (tx) => {
      await lockUserAccount(tx, target.id, "update");
      disabling = service.disableUser({ userId: target.id, actorUserId: admin.id, reason: "second" });
      await waitForAccountLockWaiter();
      await instanceUserService(tx as unknown as Db).enableUser({ userId: target.id, actorUserId: admin.id });
    });

    await expect(disabling).resolves.toMatchObject({ status: "disabled", reason: "second" });
    const open = await db
      .select()
      .from(userDisablements)
      .where(and(eq(userDisablements.userId, target.id), sql`${userDisablements.enabledAt} is null`));
    expect(open).toHaveLength(1);
  });

  it("lets the implicit local board manage admins but never be disabled itself", async () => {
    const { instanceUserService, LOCAL_BOARD_USER_ID } = await import("../services/instance-users.js");
    const now = new Date();
    await db
      .insert(authUsers)
      .values({ id: LOCAL_BOARD_USER_ID, name: "Local Board", email: "local@paperclip.local", emailVerified: true, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    const onlyAdmin = await signUp("local-mode-admin");
    await db.delete(instanceUserRoles);
    await makeAdmin(onlyAdmin.id);

    const authenticated = instanceUserService(db);
    await expect(authenticated.demoteInstanceAdmin({ userId: onlyAdmin.id })).rejects.toMatchObject({ status: 409 });

    // In local_trusted mode the implicit board is always an admin.
    const localTrusted = instanceUserService(db, { implicitLocalAdmin: true });
    await expect(localTrusted.disableUser({ userId: onlyAdmin.id, actorUserId: LOCAL_BOARD_USER_ID }))
      .resolves.toMatchObject({ status: "disabled" });
    await expect(localTrusted.disableUser({ userId: LOCAL_BOARD_USER_ID, actorUserId: onlyAdmin.id }))
      .rejects.toMatchObject({ status: 409 });
    await expect(localTrusted.deleteUser({ userId: LOCAL_BOARD_USER_ID, actorUserId: onlyAdmin.id }))
      .rejects.toMatchObject({ status: 409 });
  });
});
