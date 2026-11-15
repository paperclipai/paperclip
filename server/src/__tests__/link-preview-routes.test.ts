import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { linkPreviewRoutes } from "../routes/link-previews.js";
import { HttpError } from "../errors.js";

function app(actor: express.Request["actor"]) {
  const get = vi.fn(async () => ({ preview: null, maxAgeMs: 60_000 }));
  const cached = vi.fn(async () => ({ results: {} }));
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => { req.actor = actor; next(); });
  server.use(linkPreviewRoutes(null as unknown as Db, { get, cached }));
  server.use((error: HttpError, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  return { server, get, cached };
}
const board = { type: "board", source: "session", userId: "alice", companyIds: ["company-a"] } as const;
const path = "/companies/company-a/link-preview";

describe("link preview routes", () => {
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
    const response = await request(server).post("/companies/company-a/link-previews/cached").send({ urls: ["https://github.com/acme/web/pull/42"] });
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(cached).toHaveBeenCalledWith({ companyId: "company-a", userId: "alice" }, ["https://github.com/acme/web/pull/42"]);
    expect(get).not.toHaveBeenCalled();
    for (const body of [{}, { urls: [3] }, { urls: ["x".repeat(2049)] }, { urls: Array(51).fill("a") }]) {
      expect((await request(server).post("/companies/company-a/link-previews/cached").send(body)).status).toBe(400);
    }
    const denied = app({ ...board, companyIds: ["company-b"] });
    expect((await request(denied.server).post("/companies/company-a/link-previews/cached").send({ urls: [] })).status).toBe(403);
    expect(denied.cached).not.toHaveBeenCalled();
  });
  it("bounds and validates the URL input", async () => {
    const { server, get } = app({ ...board, companyIds: [...board.companyIds] });
    for (const query of [{}, { url: "x".repeat(2049) }, { url: ["a", "b"] }]) {
      expect((await request(server).get(path).query(query)).status).toBe(400);
    }
    expect(get).not.toHaveBeenCalled();
  });
});
