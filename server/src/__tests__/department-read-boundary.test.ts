import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS } from "@paperclipai/db";
import { LOW_TRUST_REVIEW_PRESET, type Department } from "@paperclipai/shared";
import { departmentRoutes } from "../routes/departments.js";
import { departmentService } from "../services/departments.js";
import { errorHandler } from "../middleware/error-handler.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("department read boundary", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    const external = process.env.PAPERCLIP_TEST_DATABASE_URL;
    if (external) db = createDb(external);
    else {
      database = await startEmbeddedPostgresTestDatabase("department-read-boundary-");
      db = createDb(database.connectionString);
    }
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  function app(actor: express.Request["actor"]) {
    const api = express();
    api.use(express.json());
    api.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    api.use(departmentRoutes(db));
    api.use(errorHandler);
    return api;
  }

  it("hides agents outside a low-trust read boundary and keeps department names", async () => {
    const companyId = randomUUID();
    const restrictedId = randomUUID();
    const hiddenId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Departments",
      issuePrefix: `D${companyId.slice(0, 6)}`,
    });
    await db.insert(agents).values([
      {
        id: restrictedId,
        companyId,
        name: "Restricted",
        adapterType: "process",
        status: "idle",
        permissions: {
          trustPreset: LOW_TRUST_REVIEW_PRESET,
          authorizationPolicy: {
            trustBoundary: {
              mode: LOW_TRUST_REVIEW_PRESET,
              projectIds: [],
              allowedAgentIds: [],
            },
          },
        },
      },
      {
        id: hiddenId,
        companyId,
        name: "Hidden",
        adapterType: "process",
        status: "idle",
      },
    ]);

    const departments = departmentService(db);
    const desk = await departments.create(companyId, "Desk");
    const vault = await departments.create(companyId, "Vault");
    await departments.setForAgent(companyId, restrictedId, [desk.department.id]);
    await departments.setForAgent(companyId, hiddenId, [desk.department.id, vault.department.id]);

    const restricted = {
      type: "agent" as const,
      source: "agent_key" as const,
      agentId: restrictedId,
      companyId,
    };
    const board = { type: "board" as const, source: "local_implicit" as const };

    const hiddenView = await request(app(restricted)).get(`/companies/${companyId}/departments`);
    expect(hiddenView.status).toBe(200);
    const hiddenRows = hiddenView.body as Department[];
    expect(hiddenRows.find((row) => row.name === "Desk")?.agentIds).toEqual([restrictedId]);
    expect(hiddenRows.find((row) => row.name === "Vault")?.agentIds).toEqual([]);
    expect(hiddenRows.map((row) => row.name).sort()).toEqual(["Desk", "Vault"]);

    const boardView = await request(app(board)).get(`/companies/${companyId}/departments`);
    expect(boardView.status).toBe(200);
    const boardRows = boardView.body as Department[];
    expect(boardRows.find((row) => row.name === "Desk")?.agentIds.sort()).toEqual([hiddenId, restrictedId].sort());
    expect(boardRows.find((row) => row.name === "Vault")?.agentIds).toEqual([hiddenId]);

    const replaced = await request(app(board))
      .put(`/agents/${hiddenId}/departments`)
      .send({ departmentIds: [desk.department.id, vault.department.id] });
    expect(replaced.status).toBe(200);
    const replacedRows = replaced.body as Department[];
    expect(replacedRows.find((row) => row.name === "Desk")?.agentIds.sort()).toEqual([hiddenId, restrictedId].sort());
    expect(replacedRows.find((row) => row.name === "Vault")?.agentIds).toEqual([hiddenId]);
  });
});
