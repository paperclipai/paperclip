import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Db } from "@paperclipai/db";
import { companies, agents as agentsTable } from "@paperclipai/db";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createTestDatabase } from "./test-db-helpers.ts";
import { createApp } from "../app.ts";
import type { Express } from "express";

describe("RBAC: Agent assignment on creation", () => {
  let db: Db;
  let app: Express;
  let companyId: string;
  let cooAgentId: string;
  let engineerAgentId: string;

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

    // Create test company
    const company = await db.insert(companies).values({
      id: randomUUID(),
      name: "Test Company",
    }).returning();
    companyId = company[0]!.id;

    // Create COO agent (no tasks:assign permission, no canCreateAgents)
    const cooAgent = await db.insert(agentsTable).values({
      id: randomUUID(),
      companyId,
      name: "COO",
      role: "coo",
      adapterType: "claude_local",
      status: "idle",
      permissions: null, // No special permissions
    }).returning();
    cooAgentId = cooAgent[0]!.id;

    // Create Engineer agent for assignment target
    const engineer = await db.insert(agentsTable).values({
      id: randomUUID(),
      companyId,
      name: "Engineer",
      role: "engineer",
      adapterType: "claude_local",
      status: "idle",
    }).returning();
    engineerAgentId = engineer[0]!.id;
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it("allows COO to create issue with assigneeAgentId set", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("X-Paperclip-Test-Actor", JSON.stringify({
        type: "agent",
        agentId: cooAgentId,
        companyId,
      }))
      .send({
        title: "Test Task",
        description: "Testing assignment on creation",
        assigneeAgentId: engineerAgentId,
      });

    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBe(engineerAgentId);
  });

  it("allows COO to create subtask with assigneeAgentId", async () => {
    // First create a parent task
    const parentRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("X-Paperclip-Test-Actor", JSON.stringify({
        type: "agent",
        agentId: cooAgentId,
        companyId,
      }))
      .send({
        title: "Parent Task",
        description: "Parent task",
      });

    expect(parentRes.status).toBe(201);
    const parentId = parentRes.body.id;

    // Now create a subtask with assignment
    const subtaskRes = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("X-Paperclip-Test-Actor", JSON.stringify({
        type: "agent",
        agentId: cooAgentId,
        companyId,
      }))
      .send({
        title: "Subtask",
        description: "Delegated subtask",
        parentId,
        assigneeAgentId: engineerAgentId,
      });

    expect(subtaskRes.status).toBe(201);
    expect(subtaskRes.body.assigneeAgentId).toBe(engineerAgentId);
    expect(subtaskRes.body.parentId).toBe(parentId);
  });

  it("allows agents without canCreateAgents to assign on creation", async () => {
    const res = await request(app)
      .post(`/api/companies/${companyId}/issues`)
      .set("X-Paperclip-Test-Actor", JSON.stringify({
        type: "agent",
        agentId: cooAgentId,
        companyId,
      }))
      .send({
        title: "Another Task",
        description: "Testing COO delegation",
        assigneeAgentId: cooAgentId, // Self-assign
      });

    expect(res.status).toBe(201);
    expect(res.body.assigneeAgentId).toBe(cooAgentId);
  });
});
