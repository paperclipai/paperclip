import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Db } from "@paperclipai/db";
import request from "supertest";
import { createTestDatabase } from "./test-db-helpers.ts";
import { createApp } from "../app.ts";
import type { Express } from "express";

describe("GET /api/agents/:id/runs", () => {
  let db: Db;
  let app: Express;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    app = await createApp(db, {
      uiMode: "none",
      storageService: { type: "memory" },
      deploymentMode: "local",
      deploymentExposure: "private",
      allowedHostnames: [],
      bindHost: "127.0.0.1",
      authReady: false,
      companyDeletionEnabled: false,
    });

    // Create a test company and agent
    const company = await db.insert(companies).values({
      id: randomUUID(),
      name: "Test Company",
    }).returning();
    companyId = company[0]!.id;

    const agent = await db.insert(agentsTable).values({
      id: randomUUID(),
      companyId,
      name: "Test Agent",
      role: "engineer",
      adapterType: "claude_local",
      status: "idle",
    }).returning();
    agentId = agent[0]!.id;
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("returns 200 with run list for valid agent id", async () => {
    const res = await request(app)
      .get(`/api/agents/${agentId}/runs`)
      .set("X-Paperclip-Test-Actor", JSON.stringify({ type: "board", source: "local_implicit" }));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("returns 404 for non-existent agent", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    const res = await request(app)
      .get(`/api/agents/${fakeId}/runs`)
      .set("X-Paperclip-Test-Actor", JSON.stringify({ type: "board", source: "local_implicit" }));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
  });

  it("respects limit query parameter", async () => {
    const res = await request(app)
      .get(`/api/agents/${agentId}/runs?limit=5`)
      .set("X-Paperclip-Test-Actor", JSON.stringify({ type: "board", source: "local_implicit" }));

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeLessThanOrEqual(5);
  });
});
