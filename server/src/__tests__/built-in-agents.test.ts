import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { builtInAgentService } from "../services/built-in-agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres built-in agent tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("builtInAgentService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-built-in-agents-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const [company] = await db
      .insert(companies)
      .values({ name: "Briefs Co", issuePrefix: "BFS" })
      .returning();
    return company;
  }

  it("falls back to the normal Briefs Agent record when built-in metadata is absent", async () => {
    const company = await seedCompany();
    const [agent] = await db
      .insert(agents)
      .values({
        companyId: company.id,
        name: "Briefs Agent",
        role: "general",
        status: "idle",
        adapterType: "codex_local",
      })
      .returning();

    const result = await builtInAgentService(db).requireBuiltInAgent(company.id, "briefs");

    expect(result.agent.id).toBe(agent.id);
    expect(result.warning).toBeNull();
  });

  it("marks pending approval built-in agents as unavailable", async () => {
    const company = await seedCompany();
    await db.insert(agents).values({
      companyId: company.id,
      name: "Briefs Agent",
      role: "general",
      status: "pending_approval",
      adapterType: "codex_local",
    });

    const result = await builtInAgentService(db).requireBuiltInAgent(company.id, "briefs");

    expect(result.warning).toMatchObject({
      code: "built_in_agent_unavailable",
      key: "briefs",
      status: "pending_approval",
    });
  });
});
