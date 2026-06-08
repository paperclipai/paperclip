import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authUsers, companyMemberships } from "@paperclipai/db";
import {
  actorMiddleware,
  resolveProxyAuthEmail,
  TRUSTED_PROXY_AUTH_EMAIL_ENV,
  trustedProxyEmailAllowSet,
} from "../middleware/auth.js";

type UserRow = { id: string; name: string | null; email: string | null };
type MembershipRow = { companyId: string; membershipRole: string; status: string };

function createDbFixture(input?: {
  existingUsers?: UserRow[];
  memberships?: MembershipRow[];
}) {
  const users = [...(input?.existingUsers ?? [])];
  const memberships = [...(input?.memberships ?? [])];
  const insertedUsers: UserRow[] = [];

  const db = {
    select: () => ({
      from(table: unknown) {
        return {
          where() {
            if (table === authUsers) return Promise.resolve(users);
            if (table === companyMemberships) return Promise.resolve(memberships);
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          return {
            onConflictDoUpdate() {
              return {
                returning() {
                  if (table === authUsers) {
                    const user = {
                      id: String(value.id),
                      name: value.name == null ? null : String(value.name),
                      email: value.email == null ? null : String(value.email),
                    };
                    insertedUsers.push(user);
                    users.push(user);
                    return Promise.resolve([user]);
                  }
                  return Promise.resolve([]);
                },
              };
            },
          };
        },
      };
    },
  } as any;

  return { db, insertedUsers };
}

function buildApp(db: any, resolveSession = vi.fn(async () => null)) {
  const app = express();
  app.use(express.json());
  app.use(actorMiddleware(db, {
    deploymentMode: "authenticated",
    resolveSession,
  }));
  app.get("/whoami", (req, res) => res.json(req.actor));
  return { app, resolveSession };
}

describe.sequential("trusted proxy email auth middleware", () => {
  const originalEnvValue = process.env[TRUSTED_PROXY_AUTH_EMAIL_ENV];

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env[TRUSTED_PROXY_AUTH_EMAIL_ENV];
    } else {
      process.env[TRUSTED_PROXY_AUTH_EMAIL_ENV] = originalEnvValue;
    }
  });

  it("stays disabled when PAPERCLIP_TRUST_PROXY_AUTH_EMAIL is unset", async () => {
    delete process.env[TRUSTED_PROXY_AUTH_EMAIL_ENV];
    const { db, insertedUsers } = createDbFixture();
    const { app, resolveSession } = buildApp(db);

    const res = await request(app)
      .get("/whoami")
      .set("x-auth-request-email", "operator@example.com");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "none", source: "none" });
    expect(resolveSession).toHaveBeenCalledTimes(1);
    expect(insertedUsers).toEqual([]);
  });

  it("turns an allowlisted proxy email header into a session-compatible board actor", async () => {
    process.env[TRUSTED_PROXY_AUTH_EMAIL_ENV] = "operator@example.com";
    const { db, insertedUsers } = createDbFixture({
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
    });
    const { app, resolveSession } = buildApp(db);

    const res = await request(app)
      .get("/whoami")
      .set("x-auth-request-email", " Operator@Example.com ");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "board",
      userId: "trusted-proxy:operator@example.com",
      userName: "operator@example.com",
      userEmail: "operator@example.com",
      companyIds: ["company-1"],
      isInstanceAdmin: true,
      source: "session",
    });
    expect(res.body.memberships).toEqual([
      { companyId: "company-1", membershipRole: "owner", status: "active" },
    ]);
    expect(insertedUsers).toEqual([
      { id: "trusted-proxy:operator@example.com", name: "operator@example.com", email: "operator@example.com" },
    ]);
    expect(resolveSession).not.toHaveBeenCalled();
  });

  it("ignores spoofed proxy email headers that are not explicitly allowlisted", async () => {
    process.env[TRUSTED_PROXY_AUTH_EMAIL_ENV] = "operator@example.com";
    const { db, insertedUsers } = createDbFixture();
    const { app, resolveSession } = buildApp(db);

    const res = await request(app)
      .get("/whoami")
      .set("x-auth-request-email", "attacker@example.com");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "none", source: "none" });
    expect(resolveSession).toHaveBeenCalledTimes(1);
    expect(insertedUsers).toEqual([]);
  });

  it("accepts supported trusted proxy email header aliases", () => {
    process.env[TRUSTED_PROXY_AUTH_EMAIL_ENV] = "first@example.com, operator@example.com";
    const headers = [
      "x-auth-request-email",
      "x-auth-request-user",
      "x-auth-request-preferred-username",
      "x-forwarded-email",
      "x-forwarded-user",
      "x-forwarded-preferred-username",
    ];

    for (const header of headers) {
      expect(resolveProxyAuthEmail({
        header: (name: string) => (name === header ? " Operator@Example.com " : undefined),
      } as any)).toBe("operator@example.com");
    }
  });

  it("normalizes comma-separated allowlist values", () => {
    expect(trustedProxyEmailAllowSet("A@Example.com, b@example.com, invalid")).toEqual(
      new Set(["a@example.com", "b@example.com"]),
    );
  });
});
