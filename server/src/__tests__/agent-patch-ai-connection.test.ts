import { randomUUID } from "node:crypto";

import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  principalPermissionGrants,
  toolConnectionInstalls,
} from "@paperclipai/db";
import { aiConnectionService } from "../services/ai-connections.js";

import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";

// A runtimeConfig PATCH revalidates the kept pin, and validation ends in
// a managed environment probe that exercises the selected credential
// against the live provider. A fixture credential cannot pass that probe,
// and the probe is not what this file tests: stub only the probe result.
// Selection, authorization, config merging, and persistence all run for
// real against the test database.
vi.mock("../services/agent-environment-test.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-environment-test.js")>();
  return {
    ...actual,
    agentEnvironmentTestService: (
      ...args: Parameters<typeof actual.agentEnvironmentTestService>
    ): ReturnType<typeof actual.agentEnvironmentTestService> => ({
      ...actual.agentEnvironmentTestService(...args),
      testManagedEnvironment: async () => ({ status: "pass", checks: [] }),
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

// Regression test: PATCH /agents/:id with runtimeConfig.aiConnection set to
// null must clear a previously set pin. Before the fix the validator
// rejected null outright, and the route refilled the pin from the existing
// agent whenever the requested config had no truthy aiConnection.
describeEmbeddedPostgres("agent PATCH aiConnection pin", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  const binding = { provider: "anthropic", method: "api_key", mode: "responsible_user" } as const;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-agent-patch-ai-");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = `owner-${companyId}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Agent patch ai connection test",
      issuePrefix: `AP${companyId.slice(0, 5)}`,
      defaultResponsibleUserId: userId,
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, membershipRole: "owner", status: "active",
    });
    await db.insert(principalPermissionGrants).values([
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:create" },
      // The responsible-user authorization check reads explicit grants;
      // grant the configure permission this PATCH requires directly so the
      // fixture does not depend on role-default materialization.
      { companyId, principalType: "user", principalId: userId, permissionKey: "agents:configure" },
    ]);
    // A runtimeConfig PATCH re-resolves the kept pin, and resolution for a
    // responsible_user binding needs the owner's personal default
    // connection. Seed one through the connection service so the
    // connection, grant, credential, and installs are all consistent,
    // then point the provider default at its grant.
    const connectionService = aiConnectionService(db);
    await connectionService.save(companyId, userId, {
      provider: "anthropic", method: "api_key", ownership: "personal",
      name: "Personal Claude API", loginSessionId: "fixture", agentIds: [], allAgents: true,
    }, randomUUID());
    const [seeded] = await connectionService.list(companyId, userId);
    await connectionService.setDefault(companyId, userId, seeded!.grantId);
    const existingInstalls = await db.select().from(toolConnectionInstalls)
      .where(eq(toolConnectionInstalls.connectionId, seeded!.id));
    if (!existingInstalls.length) {
      await db.insert(toolConnectionInstalls).values({
        companyId, connectionId: seeded!.id, targetType: "company", targetId: companyId,
      });
    }
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Pinned agent",
      role: "ceo",
      adapterType: "claude_local",
      runtimeConfig: { aiConnection: binding },
    });
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, status: "running", responsibleUserId: userId,
    }).returning();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "agent", agentId, companyId, runId: run!.id, source: "agent_jwt",
        onBehalfOfUserId: userId,
        onBehalfOfMemberships: [{ companyId, membershipRole: "owner", status: "active" }],
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return { app, companyId, agentId };
  }

  async function readRuntimeConfig(agentId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    return (agent?.runtimeConfig ?? {}) as Record<string, unknown>;
  }

  it("clears the pin when aiConnection is explicitly null", async () => {
    const f = await fixture();
    const res = await request(f.app)
      .patch(`/api/agents/${f.agentId}`)
      .send({ runtimeConfig: { aiConnection: null } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const runtimeConfig = await readRuntimeConfig(f.agentId);
    expect(runtimeConfig.aiConnection).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(runtimeConfig, "aiConnection")).toBe(false);
  });

  it("keeps the pin when the runtimeConfig patch omits aiConnection", async () => {
    const f = await fixture();
    const res = await request(f.app)
      .patch(`/api/agents/${f.agentId}`)
      .send({ runtimeConfig: {} });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const runtimeConfig = await readRuntimeConfig(f.agentId);
    expect(runtimeConfig.aiConnection).toEqual(binding);
  });
});
