import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authUsers, companyMemberships } from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";

function createDb(opts: {
  existingUser?: { id: string; name: string; email: string } | null;
  memberships?: Array<{ companyId: string; membershipRole: string; status: string }>;
} = {}) {
  const insertedUsers: unknown[] = [];
  const existingUser = opts.existingUser ?? null;
  const memberships = opts.memberships ?? [];

  return {
    insertedUsers,
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === authUsers) return Promise.resolve(existingUser ? [existingUser] : []);
          if (table === companyMemberships) return Promise.resolve(memberships);
          return Promise.resolve([]);
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        if (table === authUsers) insertedUsers.push(value);
        return {
          onConflictDoUpdate: () => ({
            returning: () => Promise.resolve([{ id: value.id, name: value.name, email: value.email }]),
          }),
        };
      },
    }),
  } as any;
}

function createApp(db: any, resolveSession = vi.fn(async () => null)) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession }));
  app.get("/whoami", (req, res) => res.json(req.actor));
  return app;
}

describe("trusted proxy auth middleware", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_TRUST_PROXY_AUTH_EMAIL;
  });

  it("accepts an allowlisted oauth2-proxy email header as a board admin actor", async () => {
    process.env.PAPERCLIP_TRUST_PROXY_AUTH_EMAIL = "lennie@trustedhealth.com";
    const db = createDb({
      existingUser: {
        id: "user-1",
        name: "Lennie",
        email: "lennie@trustedhealth.com",
      },
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    });
    const resolveSession = vi.fn(async () => null);

    const res = await request(createApp(db, resolveSession))
      .get("/whoami")
      .set("X-Auth-Request-Email", "Lennie@TrustedHealth.com");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "user-1",
      userEmail: "lennie@trustedhealth.com",
      companyIds: ["company-1"],
      isInstanceAdmin: true,
      source: "session",
    });
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it.each([
    ["X-Forwarded-Email"],
    ["X-Forwarded-User"],
    ["X-Auth-Request-Email"],
    ["X-Auth-Request-User"],
  ])("provisions the allowlisted proxy user from %s when it does not already exist", async (header) => {
    process.env.PAPERCLIP_TRUST_PROXY_AUTH_EMAIL = "lennie@trustedhealth.com";
    const db = createDb();

    const res = await request(createApp(db))
      .get("/whoami")
      .set(header, "lennie@trustedhealth.com");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "trusted-proxy:lennie@trustedhealth.com",
      userEmail: "lennie@trustedhealth.com",
      isInstanceAdmin: true,
      source: "session",
    });
    expect(db.insertedUsers).toHaveLength(1);
    expect(db.insertedUsers[0]).toMatchObject({
      id: "trusted-proxy:lennie@trustedhealth.com",
      email: "lennie@trustedhealth.com",
      emailVerified: true,
    });
  });

  it("ignores unallowlisted proxy email headers", async () => {
    process.env.PAPERCLIP_TRUST_PROXY_AUTH_EMAIL = "lennie@trustedhealth.com";
    const db = createDb();
    const resolveSession = vi.fn(async () => null);

    const res = await request(createApp(db, resolveSession))
      .get("/whoami")
      .set("X-Auth-Request-Email", "attacker@example.com");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ type: "none", source: "none" });
    expect(resolveSession).toHaveBeenCalledOnce();
    expect(db.insertedUsers).toHaveLength(0);
  });
});
