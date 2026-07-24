import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { userPreferencesRoutes } from "../routes/user-preferences.js";
import { errorHandler } from "../middleware/index.js";
import type { SupportedCurrency } from "@paperclipai/shared";

function createDbStub() {
  const preferences = new Map<string, { preferredCurrency: SupportedCurrency }>();

  // The service uses db.query.userPreferences.findFirst({ where: eq(userPreferences.userId, userId) })
  // The `where` parameter is a drizzle SQL object. For testing, we'll just track the last userId
  // that was used in the test actor and return the appropriate preference.
  let lastUserId: string | undefined;

  const findFirstMock = vi.fn(async (_options: { where?: unknown }) => {
    // In the actual service, the where clause is eq(userPreferences.userId, userId)
    // where userId comes from the actor. Since we control the actor in tests,
    // we can just use a simple approach: store preferences by userId and have the
    // mock return based on a known test userId.
    // The test actor uses "user-1", so we'll check for that.
    const pref = preferences.get("user-1");
    return pref ? { preferredCurrency: pref.preferredCurrency } : null;
  });

  const insertMock = vi.fn(() => ({
    values: vi.fn((values: { userId: string; preferredCurrency: SupportedCurrency }) => ({
      onConflictDoUpdate: vi.fn(() => ({
        returning: vi.fn(async () => {
          preferences.set(values.userId, { preferredCurrency: values.preferredCurrency });
          return [{ preferredCurrency: values.preferredCurrency }];
        }),
      })),
    })),
  }));

  return {
    query: {
      userPreferences: {
        findFirst: findFirstMock,
      },
    },
    insert: insertMock,
    _testHelpers: {
      getPreferences: () => preferences,
      setPreferences: (userId: string, currency: SupportedCurrency) => {
        preferences.set(userId, { preferredCurrency: currency });
      },
    },
  } as unknown as Db & { _testHelpers: { getPreferences: () => Map<string, { preferredCurrency: SupportedCurrency }>; setPreferences: (userId: string, currency: SupportedCurrency) => void } };
}

function createApp(db: Db, actor: Express.Request["actor"]) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", userPreferencesRoutes(db));
  app.use(errorHandler);
  return app;
}

describe("GET /api/users/me/preferences", () => {
  let db: ReturnType<typeof createDbStub>;
  let app: express.Express;
  const actor = {
    type: "board" as const,
    userId: "user-1",
    source: "session" as const,
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "operator" as const, status: "active" as const }],
  };

  beforeEach(() => {
    db = createDbStub();
    app = createApp(db, actor);
  });

  it("returns default USD when no preferences exist", async () => {
    const res = await request(app).get("/api/users/me/preferences");
    console.log("RESPONSE:", res.status, res.body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preferredCurrency: "USD" });
  });

  it("returns stored preferred currency", async () => {
    db._testHelpers.setPreferences("user-1", "EUR");
    const res = await request(app).get("/api/users/me/preferences");
    console.log("RESPONSE:", res.status, res.body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preferredCurrency: "EUR" });
  });

  it("returns 403 when no userId in actor", async () => {
    const appNoUser = createApp(db, { ...actor, userId: undefined });
    const res = await request(appNoUser).get("/api/users/me/preferences");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board user context required");
  });
});

describe("PATCH /api/users/me/preferences", () => {
  let db: ReturnType<typeof createDbStub>;
  let app: express.Express;
  const actor = {
    type: "board" as const,
    userId: "user-1",
    source: "session" as const,
    isInstanceAdmin: false,
    companyIds: ["company-1"],
    memberships: [{ companyId: "company-1", membershipRole: "operator" as const, status: "active" as const }],
  };

  beforeEach(() => {
    db = createDbStub();
    app = createApp(db, actor);
  });

  it("updates preferred currency to EUR", async () => {
    const res = await request(app)
      .patch("/api/users/me/preferences")
      .send({ preferredCurrency: "EUR" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ preferredCurrency: "EUR" });
  });

  it("accepts all supported currencies", async () => {
    const currencies: SupportedCurrency[] = ["USD", "EUR", "UYU", "ARS"];
    for (const currency of currencies) {
      const res = await request(app)
        .patch("/api/users/me/preferences")
        .send({ preferredCurrency: currency });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ preferredCurrency: currency });
    }
  });

  it("returns 400 for invalid currency", async () => {
    const res = await request(app)
      .patch("/api/users/me/preferences")
      .send({ preferredCurrency: "BTC" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing preferredCurrency", async () => {
    const res = await request(app)
      .patch("/api/users/me/preferences")
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 403 when no userId in actor", async () => {
    const appNoUser = createApp(db, { ...actor, userId: undefined });
    const res = await request(appNoUser)
      .patch("/api/users/me/preferences")
      .send({ preferredCurrency: "EUR" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Board user context required");
  });
});