import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { linkPreviewRoutes } from "../routes/link-previews.js";
import { HttpError } from "../errors.js";
import { createInviteRateLimiter, type InviteRateLimiter } from "../services/invite-rate-limit.js";

function app(actor: express.Request["actor"], limiter?: InviteRateLimiter) {
  const get = vi.fn(async () => ({ preview: null, maxAgeMs: 60_000 }));
  const cached = vi.fn(async () => ({ results: {} }));
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.actor = actor; next(); });
  server.use(linkPreviewRoutes(null as unknown as Db, { get, cached }, limiter));
  server.use((error: HttpError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return { server, get, cached };
}
const board = { type: "board", source: "session", userId: "alice", companyIds: ["company-a"] } as const;
const path = "/companies/company-a/link-preview";

describe("link preview routes", () => {
  it("limits lookups per viewer and company without blocking cached reads", async () => {
    let now = 0;
    const limiter = createInviteRateLimiter({ maxRequests: 2, windowMs: 1_000, now: () => now });
    const actor = { ...board, userId: "alice", companyIds: ["company-a", "company-b"] };
    const { server, get, cached } = app(actor, limiter);
    const query = { url: "https://github.com/acme/web/pull/42" };
    for (let n = 0; n < 2; n++) expect((await request(server).get(path).query(query)).status).toBe(200);
    const limited = await request(server).get(path).query(query);
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("1");
    expect(get).toHaveBeenCalledTimes(2);
    expect((await request(server).get("/companies/company-a/link-previews/cached").query(query)).status).toBe(200);
    expect(cached).toHaveBeenCalledTimes(1);
    expect((await request(server).get("/companies/company-b/link-preview").query(query)).status).toBe(200);
    actor.userId = "bob";
    expect((await request(server).get(path).query(query)).status).toBe(200);
    actor.userId = "alice";
    now = 1_001;
    expect((await request(server).get(path).query(query)).status).toBe(200);
  });
  it("passes the authenticated viewer and disables shared HTTP caching", async () => {
    const { server, get } = app({ ...board, companyIds: [...board.companyIds] });
    const response = await request(server).get(path).query({ url: "https://github.com/acme/web/pull/42" });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(get).toHaveBeenCalledWith({ companyId: "company-a", userId: "alice" }, "https://github.com/acme/web/pull/42");
  });
  it("checks company access before consulting any cache or provider", async () => {
    const { server, get } = app({ ...board, companyIds: ["company-b"] });
    expect((await request(server).get(path).query({ url: "https://github.com/acme/web/pull/42" })).status).toBe(403);
    expect(get).not.toHaveBeenCalled();
  });
  it("rejects agents and unauthenticated requests", async () => {
    for (const actor of [{ type: "none" }, { type: "agent", agentId: "agent-a", companyId: "company-a" }] as express.Request["actor"][]) {
      const { server, get } = app(actor);
      expect([401, 403]).toContain((await request(server).get(path).query({ url: "https://github.com/acme/web/pull/42" })).status);
      expect(get).not.toHaveBeenCalled();
    }
  });
  it("reads a bounded batch only after viewer and company authorization", async () => {
    const { server, cached, get } = app({ ...board, companyIds: [...board.companyIds] });
    const response = await request(server).get("/companies/company-a/link-previews/cached").query({ url: ["https://github.com/acme/web/pull/42"] });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(cached).toHaveBeenCalledWith({ companyId: "company-a", userId: "alice" }, ["https://github.com/acme/web/pull/42"]);
    expect(get).not.toHaveBeenCalled();
    for (const body of [{}, { url: ["x".repeat(2049)] }, { url: Array(51).fill("a") }]) {
      expect((await request(server).get("/companies/company-a/link-previews/cached").query(body)).status).toBe(400);
    }
    const denied = app({ ...board, companyIds: ["company-b"] });
    expect((await request(denied.server).get("/companies/company-a/link-previews/cached")).status).toBe(403);
    expect(denied.cached).not.toHaveBeenCalled();
  });
  it("lets active viewer-role members read stored statuses", async () => {
    const { server, cached } = app({ ...board, companyIds: [...board.companyIds], memberships: [{ companyId: "company-a", membershipRole: "viewer", status: "active" }] });
    expect((await request(server).get("/companies/company-a/link-previews/cached").query({ url: "https://github.com/acme/web/pull/42" })).status).toBe(200);
    expect(cached).toHaveBeenCalledTimes(1);
  });
  it("bounds and validates the URL input", async () => {
    const { server, get } = app({ ...board, companyIds: [...board.companyIds] });
    for (const query of [{}, { url: "x".repeat(2049) }, { url: ["a", "b"] }]) {
      expect((await request(server).get(path).query(query)).status).toBe(400);
    }
    expect(get).not.toHaveBeenCalled();
  });
});
