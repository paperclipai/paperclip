import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService.create CEO defaults", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agents-service-");
    db = createDb(tempDb.connectionString);
    svc = agentService(db);
  }, 20_000);

  afterAll(async () => {
    await db.delete(agents);
    await db.delete(companies);
    await tempDb?.cleanup();
  });

  it("defaults the first agent to the CEO role", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const agent = await svc.create(companyId, {
      name: "Siro Hermes",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
    });

    expect(agent.role).toBe("ceo");
    expect(agent.permissions?.canCreateAgents).toBe(true);
    expect(agent.reportsTo).toBeNull();
  });

  it("prefers the canonical CEO when duplicate shortnames exist", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const ceo = await svc.create(companyId, {
      name: "Siro Hermes",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
    });

    await db.insert(agents).values({
      companyId,
      name: "Siro Hermes",
      role: "general",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      permissions: {},
    });

    const resolved = await svc.resolveByReference(companyId, "Siro Hermes");

    expect(resolved.ambiguous).toBe(false);
    expect(resolved.agent?.id).toBe(ceo.id);
    expect(resolved.agent?.role).toBe("ceo");
  });

  it("rejects process agents without a command on create", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      svc.create(companyId, {
        name: "Broken Process Agent",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        budgetMonthlyCents: 0,
      }),
    ).rejects.toThrow("Process agents require adapterConfig.command");
  });

  it("rejects updates that would turn an agent into a commandless process adapter", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const agent = await svc.create(companyId, {
      name: "Updatable Agent",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
    });

    await expect(
      svc.update(agent.id, {
        adapterType: "process",
        adapterConfig: {},
      }),
    ).rejects.toThrow("Process agents require adapterConfig.command");
  });
});
