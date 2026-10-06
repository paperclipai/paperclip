import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agentConfigRevisions, agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { REDACTED_EVENT_VALUE, redactAgentAdapterConfig } from "../redaction.js";

const support = await getEmbeddedPostgresTestSupport();
const describeWithDb = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping agent model revision tests: ${support.reason ?? "unsupported environment"}`);
}

describeWithDb("agent model config revisions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("agent-model-revisions");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentConfigRevisions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgent(adapterConfig: Record<string, unknown>) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Model revision test",
      issuePrefix: `T${companyId.slice(0, 6).toUpperCase()}`,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Bedrock agent",
      role: "engineer",
      adapterType: "claude_local",
      adapterConfig,
    });
    return agentId;
  }

  it("preserves a Bedrock model through a response/save cycle and revision rollback", async () => {
    const model = "us.anthropic.claude-opus-4-8";
    const agentId = await seedAgent({ model, env: {} });
    const service = agentService(db);
    const before = await service.getById(agentId);
    const responseConfig = redactAgentAdapterConfig(before!.adapterConfig);
    await service.update(agentId, { icon: "bot", adapterConfig: responseConfig }, {
      recordRevision: { source: "patch" },
    });

    const [saved] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(saved.adapterConfig.model).toBe(model);
    const [revision] = await db.select().from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId));
    expect(revision.beforeConfig).toMatchObject({ adapterConfig: { model } });
    expect(revision.afterConfig).toMatchObject({ adapterConfig: { model } });

    await service.update(agentId, { adapterConfig: { model: "claude-haiku-4-5" } });
    const restored = await service.rollbackConfigRevision(agentId, revision.id, {});
    expect(restored?.adapterConfig.model).toBe(model);
  });

  it("still redacts credentials in snapshots and refuses unsafe rollback", async () => {
    const agentId = await seedAgent({
      model: "us.anthropic.claude-sonnet-4-6",
      env: { API_KEY: "test-credential-do-not-persist" },
    });
    const service = agentService(db);
    await service.update(agentId, { icon: "bot" }, { recordRevision: { source: "patch" } });
    const [revision] = await db.select().from(agentConfigRevisions)
      .where(eq(agentConfigRevisions.agentId, agentId));
    expect(revision.afterConfig).toMatchObject({
      adapterConfig: {
        model: "us.anthropic.claude-sonnet-4-6",
        env: { API_KEY: REDACTED_EVENT_VALUE },
      },
    });
    expect(JSON.stringify(revision)).not.toContain("test-credential-do-not-persist");
    await expect(service.rollbackConfigRevision(agentId, revision.id, {}))
      .rejects.toThrow("Cannot roll back a revision that contains redacted secret values");
  });
});
