import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { authRoutes } from "../routes/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

function createUpdateChain(row: unknown) {
  return {
    set(values: unknown) {
      return {
        where() {
          return {
            returning() {
              return Promise.resolve([{ ...(row as Record<string, unknown>), ...(values as Record<string, unknown>) }]);
            },
          };
        },
      };
    },
  };
}

function createDb(row: Record<string, unknown>) {
  return {
    select: () => createSelectChain([row]),
    update: () => createUpdateChain(row),
  } as any;
}

function createApp(actor: Express.Request["actor"], row: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api/auth", authRoutes(createDb(row)));
  app.use(errorHandler);
  return app;
}

describe.sequential("auth routes", () => {
  const baseUser = {
    id: "user-1",
    name: "Jane Example",
    email: "jane@example.com",
    image: "https://example.com/jane.png",
  };
  const originalSentryDsn = process.env.SENTRY_DSN;
  const originalSentryDsnFrontend = process.env.SENTRY_DSN_FRONTEND;
  const originalSentryDsnBackend = process.env.SENTRY_DSN_BACKEND;

  afterEach(() => {
    if (originalSentryDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalSentryDsn;
    if (originalSentryDsnFrontend === undefined) delete process.env.SENTRY_DSN_FRONTEND;
    else process.env.SENTRY_DSN_FRONTEND = originalSentryDsnFrontend;
    if (originalSentryDsnBackend === undefined) delete process.env.SENTRY_DSN_BACKEND;
    else process.env.SENTRY_DSN_BACKEND = originalSentryDsnBackend;
  });

  it("returns the persisted user profile in the session payload", async () => {
    delete process.env.SENTRY_DSN;
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      session: {
        id: "paperclip:session:user-1",
        userId: "user-1",
      },
      user: baseUser,
      sentryDsn: null,
    });
  });

  it("sends sentryDsn for a board actor when SENTRY_DSN is set", async () => {
    process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/1";
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body.sentryDsn).toBe("https://public@o0.ingest.sentry.io/1");
  });

  it("sends a null sentryDsn when SENTRY_DSN is unset", async () => {
    delete process.env.SENTRY_DSN;
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body.sentryDsn).toBe(null);
  });

  it("sends sentryDsn for a board actor when only SENTRY_DSN_FRONTEND is set", async () => {
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN_BACKEND;
    process.env.SENTRY_DSN_FRONTEND = "https://public-frontend@o0.ingest.sentry.io/1";
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body.sentryDsn).toBe("https://public-frontend@o0.ingest.sentry.io/1");
  });

  it("sends a null sentryDsn when only SENTRY_DSN_BACKEND is set", async () => {
    delete process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN_FRONTEND;
    process.env.SENTRY_DSN_BACKEND = "https://public-backend@o0.ingest.sentry.io/2";
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body.sentryDsn).toBe(null);
  });

  it("sends only the front-end DSN when SENTRY_DSN_FRONTEND and SENTRY_DSN_BACKEND differ", async () => {
    delete process.env.SENTRY_DSN;
    process.env.SENTRY_DSN_FRONTEND = "https://public-frontend@o0.ingest.sentry.io/1";
    process.env.SENTRY_DSN_BACKEND = "https://public-backend@o0.ingest.sentry.io/2";
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(200);
    expect(res.body.sentryDsn).toBe("https://public-frontend@o0.ingest.sentry.io/1");
    expect(res.body.sentryDsn).not.toBe("https://public-backend@o0.ingest.sentry.io/2");
  });

  it("answers 401 and sends no DSN when the actor type is none", async () => {
    process.env.SENTRY_DSN = "https://public@o0.ingest.sentry.io/1";
    const app = await createApp(
      {
        type: "none",
        source: "none",
      },
      baseUser,
    );

    const res = await request(app).get("/api/auth/get-session");

    expect(res.status).toBe(401);
    expect(res.body.sentryDsn).toBeUndefined();
  });

  it("updates the signed-in profile", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Board Operator", image: "" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "user-1",
      name: "Board Operator",
      email: "jane@example.com",
      image: null,
    });
  });

  it("preserves the existing avatar when updating only the profile name", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "local_implicit",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Board Operator" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: "user-1",
      name: "Board Operator",
      email: "jane@example.com",
      image: "https://example.com/jane.png",
    });
  });

  it("accepts Paperclip asset paths for avatars", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Jane Example", image: "/api/assets/asset-1/content" });

    expect(res.status).toBe(200);
    expect(res.body.image).toBe("/api/assets/asset-1/content");
  });

  it("rejects invalid avatar image references", async () => {
    const app = await createApp(
      {
        type: "board",
        userId: "user-1",
        source: "session",
      },
      baseUser,
    );

    const res = await request(app)
      .patch("/api/auth/profile")
      .send({ name: "Jane Example", image: "not-a-url" });

    expect(res.status).toBe(400);
  });
});
