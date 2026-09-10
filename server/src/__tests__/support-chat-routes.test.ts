import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authUsers, companies } from "@paperclipai/db";
import { errorHandler } from "../middleware/error-handler.js";
import { supportChatRoutes } from "../routes/support-chat.js";
import {
  computePlainEmailHash,
  resolveSupportChatConfig,
} from "../services/support-chat.js";
import {
  PLAIN_GRAPHQL_ENDPOINT,
  plainTenantExternalId,
  resetPlainTenantSyncForTests,
} from "../services/plain-tenant-sync.js";

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

type CompanyRow = { id: string; name: string };

function createDb(opts: { user: UserRow | null; company?: CompanyRow | null }) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === authUsers) return Promise.resolve(opts.user ? [opts.user] : []);
          if (table === companies) return Promise.resolve(opts.company ? [opts.company] : []);
          return Promise.resolve([]);
        },
      }),
    }),
  } as never;
}

const COMPANY: CompanyRow = {
  id: "0c3a49a2-6f47-4a5f-8f8e-2f4f0e2f7d11",
  name: "Plain Preview Co",
};

function createApp(opts: {
  row?: UserRow | null;
  company?: CompanyRow | null;
  actor?: Record<string, unknown> | null;
  runtimeEnv: Record<string, string | undefined>;
  nodeEnv?: string | undefined;
  tenantSyncFetch?: typeof fetch;
}) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor =
      opts.actor === undefined
        ? { type: "board", userId: "user-1", companyIds: [COMPANY.id], source: "session" }
        : opts.actor;
    next();
  });
  app.use(
    "/api/support-chat",
    supportChatRoutes(createDb({ user: opts.row ?? null, company: opts.company ?? null }), {
      runtimeEnv: opts.runtimeEnv,
      nodeEnv: "nodeEnv" in opts ? opts.nodeEnv : "test",
      tenantSyncFetch: opts.tenantSyncFetch,
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

/** A fetch stub answering Plain's upsertTenant mutation. */
function tenantUpsertFetch(result: "ok" | "mutation-error" | "http-500") {
  return vi.fn(async () => {
    if (result === "http-500") return new Response("nope", { status: 500 });
    const body =
      result === "ok"
        ? { data: { upsertTenant: { tenant: { id: "ten_1" }, error: null } } }
        : { data: { upsertTenant: { tenant: null, error: { message: "denied", code: "forbidden" } } } };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("GET /api/support-chat/session", () => {
  beforeEach(() => {
    resetPlainTenantSyncForTests();
  });

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
        externalId: "user-1",
      },
      company: null,
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

  it("returns validated company context without tenant id when no Plain API key is configured", async () => {
    const res = await request(
      createApp({ row: VERIFIED_USER, company: COMPANY, runtimeEnv: CLOUD_ENV }),
    ).get(`/api/support-chat/session?companyId=${COMPANY.id}`);

    expect(res.status).toBe(200);
    expect(res.body.company).toEqual({
      id: COMPANY.id,
      name: COMPANY.name,
      tenantExternalId: null,
      tenantId: null,
    });
  });

  it("collapses a foreign, malformed, or unknown companyId to company: null", async () => {
    const foreign = await request(
      createApp({
        row: VERIFIED_USER,
        company: COMPANY,
        runtimeEnv: CLOUD_ENV,
        actor: { type: "board", userId: "user-1", companyIds: ["e39cf1f0-0000-4000-8000-000000000000"], source: "session" },
      }),
    ).get(`/api/support-chat/session?companyId=${COMPANY.id}`);
    expect(foreign.status).toBe(200);
    expect(foreign.body.company).toBeNull();

    const malformed = await request(
      createApp({ row: VERIFIED_USER, company: COMPANY, runtimeEnv: CLOUD_ENV }),
    ).get("/api/support-chat/session?companyId=../../etc");
    expect(malformed.status).toBe(200);
    expect(malformed.body.company).toBeNull();

    const unknown = await request(
      createApp({ row: VERIFIED_USER, company: null, runtimeEnv: CLOUD_ENV }),
    ).get(`/api/support-chat/session?companyId=${COMPANY.id}`);
    expect(unknown.status).toBe(200);
    expect(unknown.body.company).toBeNull();
  });

  it("hands out the tenant externalId only after Plain confirms the tenant upsert", async () => {
    const fetchStub = tenantUpsertFetch("ok");
    const res = await request(
      createApp({
        row: VERIFIED_USER,
        company: COMPANY,
        runtimeEnv: { ...CLOUD_ENV, PLAIN_API_KEY: "plainApiKey_TEST" },
        tenantSyncFetch: fetchStub,
      }),
    ).get(`/api/support-chat/session?companyId=${COMPANY.id}`);

    expect(res.status).toBe(200);
    expect(res.body.company).toEqual({
      id: COMPANY.id,
      name: COMPANY.name,
      tenantExternalId: plainTenantExternalId(COMPANY.id),
      tenantId: "ten_1",
    });

    // The upsert went to Plain's documented endpoint with the documented
    // input shape, authenticated server-side.
    const stub = fetchStub as unknown as ReturnType<typeof vi.fn>;
    expect(stub).toHaveBeenCalledTimes(1);
    const [url, init] = stub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PLAIN_GRAPHQL_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer plainApiKey_TEST");
    const body = JSON.parse(init.body as string);
    expect(body.variables).toEqual({
      input: {
        identifier: { externalId: plainTenantExternalId(COMPANY.id) },
        name: COMPANY.name,
        externalId: plainTenantExternalId(COMPANY.id),
      },
    });
  });

  it("withholds the tenant externalId when Plain rejects or fails the upsert", async () => {
    for (const mode of ["mutation-error", "http-500"] as const) {
      resetPlainTenantSyncForTests();
      const res = await request(
        createApp({
          row: VERIFIED_USER,
          company: COMPANY,
          runtimeEnv: { ...CLOUD_ENV, PLAIN_API_KEY: "plainApiKey_TEST" },
          tenantSyncFetch: tenantUpsertFetch(mode),
        }),
      ).get(`/api/support-chat/session?companyId=${COMPANY.id}`);

      expect(res.status).toBe(200);
      expect(res.body.company).toEqual({
        id: COMPANY.id,
        name: COMPANY.name,
        tenantExternalId: null,
      tenantId: null,
      });
    }
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
    ).toEqual({ appId: "app", emailHmacSecret: null, tenantSyncApiKey: null, devPreview: false });
    expect(
      resolveSupportChatConfig(
        { PLAIN_CHAT_APP_ID: "app", PAPERCLIP_MANAGED_CONFIG: "{}" },
        "production",
      ),
    ).toEqual({ appId: "app", emailHmacSecret: null, tenantSyncApiKey: null, devPreview: false });
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
    expect(config).toEqual({ appId: "app", emailHmacSecret: null, tenantSyncApiKey: null, devPreview: false });
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
