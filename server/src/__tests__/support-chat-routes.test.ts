import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { authUsers } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { supportChatRoutes } from "../routes/support-chat.js";
import {
  computePlainEmailHash,
  resolveSupportChatConfig,
} from "../services/support-chat.js";
const CLOUD_ENV = {
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-token",
  PLAIN_CHAT_APP_ID: "liveChatApp_TEST",
  PLAIN_CHAT_EMAIL_HMAC_SECRET: "hmac-secret",
};

type UserRow = {
  id: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
};

function createDb(opts: { user: UserRow | null }) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === authUsers) return Promise.resolve(opts.user ? [opts.user] : []);
          return Promise.resolve([]);
        },
      }),
    }),
  } as never;
}

function createApp(opts: {
  row?: UserRow | null;
  actor?: Record<string, unknown> | null;
  runtimeEnv: Record<string, string | undefined>;
  nodeEnv?: string | undefined;
}) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor =
      opts.actor === undefined
        ? { type: "board", userId: "user-1", source: "session" }
        : opts.actor;
    next();
  });
  app.use(
    "/api/support-chat",
    supportChatRoutes(createDb({ user: opts.row ?? null }), {
      runtimeEnv: opts.runtimeEnv,
      nodeEnv: "nodeEnv" in opts ? opts.nodeEnv : "test",
    }),
  );
  app.use(errorHandler);
  return app;
}

const VERIFIED_USER: UserRow = {
  id: "user-1",
  email: "michael@example.com",
  name: "Michael Nguyen",
  emailVerified: true,
};

describe("GET /api/support-chat/session", () => {
  it("answers 404 with support_chat_disabled when no Chat App id is configured", async () => {
    const res = await request(
      createApp({ row: VERIFIED_USER, runtimeEnv: { PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "t" } }),
    ).get("/api/support-chat/session");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("support_chat_disabled");
  });

  it("answers 404 on a self-hosted instance even when the Chat App id is set", async () => {
    const res = await request(
      createApp({ row: VERIFIED_USER, runtimeEnv: { PLAIN_CHAT_APP_ID: "liveChatApp_TEST" } }),
    ).get("/api/support-chat/session");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("support_chat_disabled");
  });

  it("serves the widget config and an HMAC-attested identity on a Cloud-managed instance", async () => {
    const res = await request(createApp({ row: VERIFIED_USER, runtimeEnv: CLOUD_ENV })).get(
      "/api/support-chat/session",
    );

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      provider: "plain",
      appId: "liveChatApp_TEST",
      devPreview: false,
      customer: {
        email: "michael@example.com",
        emailHash: createHmac("sha256", "hmac-secret")
          .update("michael@example.com")
          .digest("hex"),
        fullName: "Michael Nguyen",
      },
    });
  });

  it("ignores caller-supplied identity input — the hash always derives from the session user", async () => {
    const res = await request(createApp({ row: VERIFIED_USER, runtimeEnv: CLOUD_ENV })).get(
      "/api/support-chat/session?email=attacker@evil.example",
    );

    expect(res.status).toBe(200);
    expect(res.body.customer.email).toBe("michael@example.com");
    expect(res.body.customer.emailHash).toBe(
      computePlainEmailHash("hmac-secret", "michael@example.com"),
    );
  });

  it("withholds the identity block when the email is unverified", async () => {
    const res = await request(
      createApp({ row: { ...VERIFIED_USER, emailVerified: false }, runtimeEnv: CLOUD_ENV }),
    ).get("/api/support-chat/session");

    expect(res.status).toBe(200);
    expect(res.body.customer).toBeNull();
  });

  it("withholds the identity block when no HMAC secret is configured", async () => {
    const res = await request(
      createApp({
        row: VERIFIED_USER,
        runtimeEnv: { ...CLOUD_ENV, PLAIN_CHAT_EMAIL_HMAC_SECRET: undefined },
      }),
    ).get("/api/support-chat/session");

    expect(res.status).toBe(200);
    expect(res.body.customer).toBeNull();
  });

  it("requires a board actor", async () => {
    const agent = await request(
      createApp({
        row: VERIFIED_USER,
        runtimeEnv: CLOUD_ENV,
        actor: { type: "agent", agentId: "agent-1" },
      }),
    ).get("/api/support-chat/session");
    expect(agent.status).toBe(401);

    const missingUser = await request(
      createApp({ row: VERIFIED_USER, runtimeEnv: CLOUD_ENV, actor: { type: "board" } }),
    ).get("/api/support-chat/session");
    expect(missingUser.status).toBe(401);
  });

  it("rejects an unknown session user", async () => {
    const res = await request(createApp({ row: null, runtimeEnv: CLOUD_ENV })).get(
      "/api/support-chat/session",
    );

    expect(res.status).toBe(401);
  });

  it("honors the dev preview opt-in on a non-production, non-Cloud process", async () => {
    const res = await request(
      createApp({
        row: VERIFIED_USER,
        runtimeEnv: {
          PLAIN_CHAT_APP_ID: "liveChatApp_TEST",
          PAPERCLIP_SUPPORT_CHAT_DEV_PREVIEW: "1",
        },
        nodeEnv: "development",
      }),
    ).get("/api/support-chat/session");

    expect(res.status).toBe(200);
    expect(res.body.devPreview).toBe(true);
    // No HMAC secret in this env — the widget mounts unauthenticated.
    expect(res.body.customer).toBeNull();
  });

  it("refuses the dev preview opt-in on a production build", async () => {
    const res = await request(
      createApp({
        row: VERIFIED_USER,
        runtimeEnv: {
          PLAIN_CHAT_APP_ID: "liveChatApp_TEST",
          PAPERCLIP_SUPPORT_CHAT_DEV_PREVIEW: "1",
        },
        nodeEnv: "production",
      }),
    ).get("/api/support-chat/session");

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("support_chat_disabled");
  });
});

describe("resolveSupportChatConfig", () => {
  it("is disabled by default", () => {
    expect(resolveSupportChatConfig({}, "development")).toBeNull();
  });

  it("treats blank values as absent", () => {
    expect(
      resolveSupportChatConfig(
        { PLAIN_CHAT_APP_ID: "  ", PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "t" },
        "production",
      ),
    ).toBeNull();
  });

  it("enables through either Cloud-managed signal", () => {
    expect(
      resolveSupportChatConfig(
        { PLAIN_CHAT_APP_ID: "app", PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "t" },
        "production",
      ),
    ).toEqual({ appId: "app", emailHmacSecret: null, devPreview: false });
    expect(
      resolveSupportChatConfig(
        { PLAIN_CHAT_APP_ID: "app", PAPERCLIP_MANAGED_CONFIG: "{}" },
        "production",
      ),
    ).toEqual({ appId: "app", emailHmacSecret: null, devPreview: false });
  });

  it("ignores the dev opt-in on a Cloud-managed instance", () => {
    const config = resolveSupportChatConfig(
      {
        PLAIN_CHAT_APP_ID: "app",
        PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "t",
        PAPERCLIP_SUPPORT_CHAT_DEV_PREVIEW: "1",
      },
      "development",
    );
    expect(config).toEqual({ appId: "app", emailHmacSecret: null, devPreview: false });
  });

  it("requires an explicit truthy opt-in value", () => {
    expect(
      resolveSupportChatConfig(
        { PLAIN_CHAT_APP_ID: "app", PAPERCLIP_SUPPORT_CHAT_DEV_PREVIEW: "yes" },
        "development",
      ),
    ).toBeNull();
  });
});

describe("computePlainEmailHash", () => {
  it("matches Plain's documented hex HMAC-SHA256 construction", () => {
    // Independent fixture computed with `crypto.createHmac("sha256", "sec")
    // .update("a@b.c").digest("hex")` — guards against accidental digest or
    // encoding changes.
    expect(computePlainEmailHash("sec", "a@b.c")).toBe(
      "4597ffe4e782c2495f40117f67ed2e917fe28e978550db6f83e97c73be39a0e6",
    );
  });
});
