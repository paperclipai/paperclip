import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInviteRateLimiter } from "../services/invite-rate-limit.js";

function createSelectChain(rows: unknown[]) {
  const query = {
    then(resolve: (value: unknown[]) => unknown) {
      return Promise.resolve(rows).then(resolve);
    },
    leftJoin() {
      return query;
    },
    orderBy() {
      return query;
    },
    where() {
      return query;
    },
  };
  return {
    from() {
      return query;
    },
  };
}

function createDbStub(...selectResponses: unknown[][]) {
  let selectCall = 0;
  return {
    select() {
      const rows = selectResponses[selectCall] ?? [];
      selectCall += 1;
      return createSelectChain(rows);
    },
  };
}

async function createApp(db: Record<string, unknown>) {
  const [{ accessRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/access.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = { type: "anon" };
    next();
  });
  app.use(
    "/api",
    accessRoutes(db as any, {
      deploymentMode: "local_trusted",
      deploymentExposure: "private",
      bindHost: "127.0.0.1",
      allowedHostnames: [],
      inviteRateLimiter: createInviteRateLimiter({
        maxRequests: 1,
        windowMs: 60_000,
        now: () => 1_000,
      }),
    }),
  );
  app.use(errorHandler);
  return app;
}

describe("invite-token endpoint rate limiting", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 429 once the per-IP threshold is exceeded", async () => {
    // No invite row -> route would 404, but the rate-limit middleware runs first
    // and short-circuits on the second request.
    const app = await createApp(createDbStub([], [], [], [], []));

    const first = await request(app).get(
      "/api/invites/pcp_invite_aaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(first.status).toBe(404);

    const limited = await request(app).get(
      "/api/invites/pcp_invite_aaaaaaaaaaaaaaaaaaaaaa",
    );
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.body).toMatchObject({
      error: "Too many invite requests",
      details: { retryAfterSeconds: 60 },
    });
  }, 15_000);

  it("also rate-limits the accept sub-route", async () => {
    const app = await createApp(createDbStub([], [], [], [], []));

    await request(app).get("/api/invites/pcp_invite_bbbbbbbbbbbbbbbbbbbbbb");

    const limited = await request(app)
      .post("/api/invites/pcp_invite_bbbbbbbbbbbbbbbbbbbbbb/accept")
      .send({});
    expect(limited.status).toBe(429);
  });

  it("ignores client-supplied X-Forwarded-For — spoofed IPs do not reset the budget", async () => {
    // `trust proxy` is unset here (Express default: trust nothing), so the
    // rate-limit key is the socket's remote address. Rotating fake
    // X-Forwarded-For values must NOT mint a fresh per-IP budget.
    const app = await createApp(createDbStub([], [], [], [], []));

    const first = await request(app)
      .get("/api/invites/pcp_invite_cccccccccccccccccccccc")
      .set("x-forwarded-for", "1.1.1.1");
    expect(first.status).toBe(404);

    const spoofed = await request(app)
      .get("/api/invites/pcp_invite_cccccccccccccccccccccc")
      .set("x-forwarded-for", "1.1.1.2");
    expect(spoofed.status).toBe(429);
  });
});
