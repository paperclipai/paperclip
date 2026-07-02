import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("resolveByReference", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let service: ReturnType<typeof agentService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agents-fuzzy-test-");
    db = createDb(tempDb.connectionString);
    service = agentService(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  it("resolves agents by fuzzy name matching", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });

    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Product Lead",
      urlKey: "product-lead",
      status: "idle",
      role: "lead",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    const res1 = await service.resolveByReference(companyId, "product-lead");
    expect(res1.agent?.id).toBe(agentId);
    expect(res1.ambiguous).toBe(false);

    const res2 = await service.resolveByReference(companyId, "ProductLead");
    expect(res2.agent?.id).toBe(agentId);
    expect(res2.ambiguous).toBe(false);

    const res3 = await service.resolveByReference(companyId, "Product Lead");
    expect(res3.agent?.id).toBe(agentId);
    expect(res3.ambiguous).toBe(false);

    const res4 = await service.resolveByReference(companyId, "product_lead!");
    expect(res4.agent?.id).toBe(agentId);
    expect(res4.ambiguous).toBe(false);
  });

  it("returns ambiguous when fuzzy match hits multiple agents", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Test Co" });

    // Create two agents that normalize down to the exact same fuzzy string
    // "fuzzymatch"
    await db.insert(agents).values([
      {
        id: randomUUID(),
        companyId,
        name: "Fuzzy Match",
        urlKey: "fuzzy-match",
        status: "idle",
        role: "lead",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: randomUUID(),
        companyId,
        name: "FuzzyMatch",
        urlKey: "fuzzymatch",
        status: "idle",
        role: "lead",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    // Searching for "Fuzz_yMatch" normalizes to urlKey "fuzz-ymatch", which doesn't exist.
    // It will fall back to fuzzy match, which strips to "fuzzymatch".
    // Both agents strip to "fuzzymatch", so it returns ambiguous.
    const res = await service.resolveByReference(companyId, "Fuzz_yMatch");
    expect(res.ambiguous).toBe(true);
    expect(res.agent).toBeNull();
  });
});
