import express from "express";
import { createHash } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, announcementDismissals, announcementPublications, companies, createDb, startEmbeddedPostgresTestDatabase, type EmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { announcementRoutes } from "../routes/announcements.js";
import { announcementService } from "../services/announcements.js";
import { errorHandler } from "../middleware/error-handler.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const otherCompanyId = "22222222-2222-4222-8222-222222222222";
const item = { id: "new-projects", eyebrow: "New", title: "Projects", description: "Organize your work.", primaryAction: { kind: "route", label: "Open", path: "/projects" } };
describe("announcement routes and durable dismissals", () => {
  let database: EmbeddedPostgresTestDatabase;
  let db: ReturnType<typeof createDb>;
  function app(userId = "alice", actorOverride?: Record<string, unknown>, announcement: unknown = item, feedStatus = 200, animationHtml?: string) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      req.actor = (actorOverride ?? { type: "board", userId, source: "session", companyIds: [companyId, otherCompanyId], memberships: [{ companyId, membershipRole: "viewer", status: "active" }] }) as never;
      next();
    });
    server.use("/api", announcementRoutes(db, { version: "2026.913.0", fetch: async (url) => animationHtml && url.pathname.endsWith(".html") ? new Response(animationHtml, { headers: { "Content-Type": "text/html" } }) : new Response(JSON.stringify({ schemaVersion: 1, announcement }), { status: feedStatus, headers: { "Content-Type": "application/json" } }) }));
    server.use(errorHandler);
    return server;
  }
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-announcements-");
    db = createDb(database.connectionString);
    await db.insert(companies).values([{ id: companyId, name: "Test", issuePrefix: "ANN" }, { id: otherCompanyId, name: "Other", issuePrefix: "ANB" }]);
  }, 90_000);
  beforeEach(async () => { await db.delete(announcementDismissals); await db.delete(announcementPublications); await db.delete(activityLog); });
  afterAll(async () => { await database?.cleanup(); }, 30_000);
  it.each([200, 404])("returns a successful empty response for no remote announcement (HTTP %s)", async (status) => {
    const response = await request(app("alice", undefined, null, status)).get("/api/announcements/current");
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });
  it("serves animation documents with a sandbox and network-denying CSP", async () => {
    const html = "<div>Team</div>";
    const path = `assets/${createHash("sha256").update(html).digest("hex")}.html`;
    const server = app("alice", undefined, { ...item, image: { path: `assets/${"0".repeat(64)}.png`, alt: "Poster" }, animation: { path, alt: "Team" } }, 200, html);
    const response = await request(server).get(`/api/announcements/${item.id}/animation`);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-security-policy"]).toContain("sandbox; default-src 'none'");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.type).toBe("text/html");
    expect((await request(server).get("/api/announcements/wrong-id/animation")).status).toBe(404);
  });
  it("persists across app/service restarts, browsers and companies, isolated by user", async () => {
    const first = app();
    const response = await request(first).get("/api/announcements/current");
    expect(response.body.id).toBe(item.id);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect((await request(first).post(`/api/announcements/${item.id}/dismiss`).send({ companyId })).status).toBe(204);
    expect((await request(app()).get("/api/announcements/current")).body).toBeNull();
    expect((await request(app("bob")).get("/api/announcements/current")).body.id).toBe(item.id);
    await request(app()).post(`/api/announcements/${item.id}/dismiss`).send({ companyId: otherCompanyId });
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });
  it("accepts viewers and concurrent duplicate dismissals with one audit", async () => {
    const server = app();
    await request(server).get("/api/announcements/current");
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(server).post(`/api/announcements/${item.id}/dismiss`).send({ companyId })));
    expect(responses.map((res) => res.status)).toEqual([204, 204, 204, 204, 204]);
    expect(await db.select().from(announcementDismissals)).toHaveLength(1);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "announcement.dismissed"))).toHaveLength(1);
  });
  it("rolls back the dismissal if its audit cannot commit", async () => {
    await announcementService(db).registerPublication(item.id);
    await expect(announcementService(db).dismiss("alice", item.id, "33333333-3333-4333-8333-333333333333")).rejects.toThrow();
    expect(await announcementService(db).isDismissed("alice", item.id)).toBe(false);
  });
  it("never resurrects a dismissed ID after copy changes or rollback; a new ID appears", async () => {
    await announcementService(db).registerPublication(item.id);
    await announcementService(db).dismiss("alice", item.id, companyId);
    expect((await request(app("alice", undefined, { ...item, title: "Fixed copy" })).get("/api/announcements/current")).body).toBeNull();
    expect((await request(app("alice", undefined, { ...item, id: "next" })).get("/api/announcements/current")).body.id).toBe("next");
    expect((await request(app()).get("/api/announcements/current")).body).toBeNull();
  });
  it("uses the local-board identity without an auth user row", async () => {
    const server = app("local-board", { type: "board", userId: "local-board", source: "local_implicit" });
    await request(server).get("/api/announcements/current");
    expect((await request(server).post(`/api/announcements/${item.id}/dismiss`).send({ companyId })).status).toBe(204);
    expect(await announcementService(db).isDismissed("local-board", item.id)).toBe(true);
  });
  it("rejects invented IDs without storing dismissals or audit entries", async () => {
    const server = app();
    await request(server).get("/api/announcements/current");
    for (const id of ["invented-one", "invented-two", "invented-three"]) {
      expect((await request(server).post(`/api/announcements/${id}/dismiss`).send({ companyId })).status).toBe(404);
    }
    expect(await db.select().from(announcementDismissals)).toHaveLength(0);
    expect(await db.select().from(activityLog)).toHaveLength(0);
    expect(await db.select().from(announcementPublications)).toEqual([{ announcementId: item.id }]);
  });
  it("accepts offline retries for validated IDs after withdrawal and restart", async () => {
    await request(app()).get("/api/announcements/current");
    const restarted = app("alice", undefined, null, 404);
    expect((await request(restarted).get("/api/announcements/current")).body).toBeNull();
    expect((await request(restarted).post(`/api/announcements/${item.id}/dismiss`).send({ companyId })).status).toBe(204);
    expect(await announcementService(db).isDismissed("alice", item.id)).toBe(true);
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });
  it("rejects anonymous/agent callers and inaccessible audit companies", async () => {
    for (const actor of [{ type: "none" }, { type: "agent", companyId, userId: "alice" }]) {
      const server = app("alice", actor);
      const expected = actor.type === "none" ? 401 : 403;
      for (const url of ["current", `${item.id}/image`, `${item.id}/animation`]) expect((await request(server).get(`/api/announcements/${url}`)).status).toBe(expected);
      expect((await request(server).post(`/api/announcements/${item.id}/dismiss`).send({ companyId })).status).toBe(expected);
    }
    expect((await request(app()).post(`/api/announcements/${item.id}/dismiss`).send({ companyId: "33333333-3333-4333-8333-333333333333" })).status).toBe(404);
    expect((await request(app()).post(`/api/announcements/${item.id}/dismiss`).send({ companyId, userId: "bob" })).status).toBe(400);
  });
});
