import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/index.js";
import { cloudRoutes } from "../routes/cloud.js";

const cloudEnv = {
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "tenant-secret",
  PAPERCLIP_CLOUD_STACK_ID: "stack-current",
  PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test/control-plane",
};

function cloudActor(userId: string) {
  return {
    type: "board" as const,
    source: "cloud_tenant" as const,
    userId,
    companyIds: ["company-1"],
  };
}

function createApp(options: {
  actor?: ReturnType<typeof cloudActor> | {
    type: "board";
    source: "session";
    userId: string;
  };
  runtimeEnv?: Record<string, string | undefined>;
  fetchImpl: typeof fetch;
  now?: () => number;
}) {
  const app = express();
  app.use((req, _res, next) => {
    (req as any).actor = options.actor ?? cloudActor("actor-user");
    next();
  });
  app.use("/api/cloud", cloudRoutes({
    runtimeEnv: options.runtimeEnv ?? cloudEnv,
    fetchImpl: options.fetchImpl,
    now: options.now,
  }));
  app.use(errorHandler);
  return app;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/cloud/stacks", () => {
  it("returns the actor's portfolio without forwarding client-supplied identity", async () => {
    const portfolio = { stacks: [{ slug: "current", displayName: "Current" }] };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(portfolio));
    const app = createApp({ fetchImpl });

    const res = await request(app)
      .get("/api/cloud/stacks?userId=client-supplied-user")
      .set("x-paperclip-cloud-user-id", "spoofed-header-user")
      .set("authorization", "Bearer client-token");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(portfolio);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url.toString()).toBe("https://cloud.example.test/v1/tenant/portfolio");
    expect(init).toMatchObject({ method: "GET" });
    expect(init?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer tenant-secret",
      "x-paperclip-cloud-user-id": "actor-user",
      "x-paperclip-cloud-stack-id": "stack-current",
    });
    expect(JSON.stringify(init)).not.toContain("client-supplied-user");
    expect(JSON.stringify(init)).not.toContain("spoofed-header-user");
    expect(JSON.stringify(init)).not.toContain("client-token");
  });

  it("caches successful portfolios per actor for 30 seconds", async () => {
    let currentTime = 1_000;
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ generation: 1 }))
      .mockResolvedValueOnce(jsonResponse({ generation: 2 }));
    const app = createApp({ fetchImpl, now: () => currentTime });

    const first = await request(app).get("/api/cloud/stacks");
    currentTime += 29_999;
    const cached = await request(app).get("/api/cloud/stacks");
    currentTime += 1;
    const refreshed = await request(app).get("/api/cloud/stacks");

    expect(first.body).toEqual({ generation: 1 });
    expect(cached.body).toEqual({ generation: 1 });
    expect(refreshed.body).toEqual({ generation: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps cache entries isolated by the server-derived actor user id", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const headers = new Headers(init?.headers);
      return jsonResponse({ userId: headers.get("x-paperclip-cloud-user-id") });
    });
    const app = express();
    app.use((req, _res, next) => {
      const userId = req.header("x-test-actor-user") ?? "user-a";
      (req as any).actor = cloudActor(userId);
      next();
    });
    app.use("/api/cloud", cloudRoutes({ runtimeEnv: cloudEnv, fetchImpl }));
    app.use(errorHandler);

    const first = await request(app).get("/api/cloud/stacks").set("x-test-actor-user", "user-a");
    const second = await request(app).get("/api/cloud/stacks").set("x-test-actor-user", "user-b");
    const firstAgain = await request(app).get("/api/cloud/stacks").set("x-test-actor-user", "user-a");

    expect(first.body).toEqual({ userId: "user-a" });
    expect(second.body).toEqual({ userId: "user-b" });
    expect(firstAgain.body).toEqual({ userId: "user-a" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns 404 on self-hosted instances without calling upstream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({ runtimeEnv: {}, fetchImpl });

    const res = await request(app).get("/api/cloud/stacks");

    expect(res.status).toBe(404);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects non-tenant actors on managed instances without calling upstream", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const app = createApp({
      actor: { type: "board", source: "session", userId: "session-user" },
      fetchImpl,
    });

    const res = await request(app).get("/api/cloud/stacks");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("cloud_tenant_required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
