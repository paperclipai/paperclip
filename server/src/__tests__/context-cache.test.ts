import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { getCachedAgentContext, setCachedAgentContext, invalidateCachedAgentContext } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping context cache tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("context cache functions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let agentId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-context-cache-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "running",
      adapterType: "opencode_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents).where(agents.id.equals(agentId));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("setCachedAgentContext and getCachedAgentContext", () => {
    it("returns null when no cache exists", async () => {
      const result = await getCachedAgentContext(db, agentId);
      expect(result).toBeNull();
    });

    it("stores and retrieves compressed context", async () => {
      const payload = { messages: [{ role: "user", content: "hello" }] };
      await setCachedAgentContext(db, agentId, payload);
      const result = await getCachedAgentContext(db, agentId);
      expect(result).not.toBeNull();
      expect(result!.payload).toEqual(payload);
      expect(result!.fetchOnDemand).toBe(false);
    });

    it("marks cache as fetch-on-demand when context exceeds size limit", async () => {
      const largePayload = { messages: Array(1000).fill({ role: "user", content: "x".repeat(500) }) };
      await setCachedAgentContext(db, agentId, largePayload);
      const result = await getCachedAgentContext(db, agentId);
      expect(result).not.toBeNull();
      expect(result!.fetchOnDemand).toBe(true);
      expect(result!.summary).toBeDefined();
    });
  });

  describe("invalidateCachedAgentContext", () => {
    it("removes cached context", async () => {
      const payload = { messages: [{ role: "user", content: "hello" }] };
      await setCachedAgentContext(db, agentId, payload);
      await invalidateCachedAgentContext(db, agentId);
      const result = await getCachedAgentContext(db, agentId);
      expect(result).toBeNull();
    });
  });
});
