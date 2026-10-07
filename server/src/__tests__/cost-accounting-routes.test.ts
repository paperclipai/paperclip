import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { costRoutes } from "../routes/costs.js";
import { errorHandler } from "../middleware/error-handler.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("accounting operator authorization", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, foreignId: string, agentId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("accounting-authz-"); db = createDb(database.connectionString);
    const rows = await db.insert(companies).values([{ name: "A", issuePrefix: "AUTH_A" }, { name: "B", issuePrefix: "AUTH_B" }]).returning();
    companyId = rows[0].id; foreignId = rows[1].id;
    agentId = (await db.insert(agents).values({ companyId, name: "Worker", role: "engineer", adapterType: "process" }).returning())[0].id;
  },30_000);
  afterAll(async () => { await database?.cleanup(); });
  function app(actor: Record<string, unknown>) {
    const app = express(); app.use(express.json()); app.use((req,_res,next) => { req.actor = actor as typeof req.actor; next(); });
    app.use("/api", costRoutes(db)); app.use(errorHandler); return app;
  }
  const operations = [
    ["get", "health", undefined], ["get", "inspect", undefined], ["get", "invoices", undefined],
    ["get", `invoices/${randomUUID()}`, undefined], ["get", `events/${randomUUID()}/adjustments`, undefined],
    ["post", "repair", { fingerprint: "a".repeat(64), reason: "test" }],
    ["post", "provider-costs/import", {}], ["post", "retry", { runId: randomUUID() }], ["post", "invoices", {}], ["post", `events/${randomUUID()}/adjustments`, {}],
  ] as const;
  it.each(operations)("denies agents for %s %s before reading or validating operator payloads", async (method, route, body) => {
    const response = await request(app({ type: "agent", companyId, agentId }))[method](`/api/companies/${companyId}/accounting/${route}`).send(body);
    expect(response.status).toBe(403);
  });
  it.each(operations)("denies nonmembers for %s %s", async (method, route, body) => {
    const response = await request(app({ type: "board", source: "session", userId: "operator", companyIds: [foreignId] }))[method](`/api/companies/${companyId}/accounting/${route}`).send(body);
    expect(response.status).toBe(403);
  });
  it("allows operator inspection and rejects viewer mutations", async () => {
    const board = { type: "board", source: "session", userId: "operator", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole: "viewer" }] };
    const response = await request(app(board)).get(`/api/companies/${companyId}/accounting/inspect`);
    expect(response.status).toBe(200); expect(response.body.findings).toEqual([]);
    expect((await request(app(board)).post(`/api/companies/${companyId}/accounting/repair`).send({ fingerprint: response.body.fingerprint, reason: "test" })).status).toBe(403);
  });
  it.each(["member", "viewer", "unknown", undefined])("denies provider credential use by %s before payload validation", async (membershipRole) => {
    const actor = { type: "board", source: "session", userId: "member", companyIds: [companyId], memberships: [{ companyId, status: "active", membershipRole }] };
    const response = await request(app(actor)).post(`/api/companies/${companyId}/accounting/provider-costs/import`).send({});
    expect(response.status).toBe(403);
  });
  it.each([
    { source: "session", memberships: "owner" },
    { source: "session", memberships: "admin" },
    { source: "session", isInstanceAdmin: true },
    { source: "local_implicit" },
  ])("allows billing operators through to payload validation: %j", async (input) => {
    const actor = { ...input, type: "board", userId: "operator", companyIds: [companyId], memberships: input.memberships ? [{ companyId, status: "active", membershipRole: input.memberships }] : [] };
    const response = await request(app(actor)).post(`/api/companies/${companyId}/accounting/provider-costs/import`).send({});
    expect(response.status).toBe(400);
  });
  it("does not accept an inactive admin or an admin role from another company", async () => {
    for (const membership of [
      { companyId, status: "suspended", membershipRole: "admin" },
      { companyId: foreignId, status: "active", membershipRole: "admin" },
    ]) {
      const response = await request(app({ type: "board", source: "session", userId: "operator", companyIds: [companyId], memberships: [membership] }))
        .post(`/api/companies/${companyId}/accounting/provider-costs/import`).send({});
      expect(response.status).toBe(403);
    }
  });
  it("authorizes the user cost report and validates its date range", async () => {
    const path = `/api/companies/${companyId}/costs/by-user`;
    const board = app({ type: "board", source: "local_implicit", userId: "operator" });
    const response = await request(board).get(`${path}?period=all`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ activeUserCount: 0, rows: [] });
    for (const query of ["from=invalid", "from=2026-02-01&to=2026-01-01", "period=all&from=2026-01-01"]) {
      expect((await request(board).get(`${path}?${query}`)).status).toBe(400);
    }
    for (const actor of [
      { type: "board", source: "session", userId: "outsider", companyIds: [foreignId] },
      { type: "agent", companyId: foreignId, agentId },
    ]) expect((await request(app(actor)).get(path)).status).toBe(403);
    expect((await request(app({ type: "none" })).get(path)).status).toBe(401);
  });

  it("validates correction and repair payloads before mutating", async () => {
    const board = app({ type: "board", source: "local_implicit", userId: "operator" });
    expect((await request(board).post(`/api/companies/${companyId}/accounting/repair`).send({ fingerprint: "old", reason: "" })).status).toBe(400);
    expect((await request(board).post(`/api/companies/${companyId}/accounting/events/${randomUUID()}/adjustments`).send({ idempotencyKey: "x", expectedCents: "0", correctedCents: "-0.000000001", reason: "Invalid", pricing: { source: "operator" } })).status).toBe(400);
  });
});
