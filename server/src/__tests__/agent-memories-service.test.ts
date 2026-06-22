import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentMemories, agents, companies, createDb } from "@paperclipai/db";
import { agentMemoryService, redactSecrets } from "../services/agent-memories.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const boardActor = { actorType: "user" as const, actorId: "board" };
const agentActor = (id: string) => ({ actorType: "agent" as const, actorId: id });

async function seedCompanyAndAgent(db: ReturnType<typeof createDb>) {
  const companyId = randomUUID();
  const agentId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Atelier",
    issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values({
    id: agentId,
    companyId,
    name: "Sarah",
    role: "cto",
    status: "active",
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    permissions: {},
  });
  return { companyId, agentId };
}

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("agentMemoryService (per-agent long-term memory)", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof agentMemoryService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("atelier-agent-memory-");
    db = createDb(tempDb.connectionString);
    svc = agentMemoryService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agentMemories);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("writes and recalls a memory scoped to the agent (migration applied)", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const created = await svc.write(
      companyId,
      agentId,
      { type: "semantic", title: "Deploys at 9am", body: "Prod deploys land at 9am UTC", tags: ["ops"], confidence: 80 },
      boardActor,
    );
    expect(created.id).toEqual(expect.any(String));
    expect(created.status).toBe("active");

    const recalled = await svc.recall(companyId, agentId, { limit: 20 });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].title).toBe("Deploys at 9am");
    expect(recalled[0].recallCount).toBe(0); // returned rows reflect pre-bump state
  });

  it("filters recall by type, tag overlap, and free text", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    await svc.write(companyId, agentId, { type: "semantic", title: "Stripe key location", body: "in secrets", tags: ["billing"] }, boardActor);
    await svc.write(companyId, agentId, { type: "lesson", title: "Rollback on 500s", body: "always rollback", tags: ["ops", "incident"] }, boardActor);

    expect(await svc.recall(companyId, agentId, { type: "lesson", limit: 20 })).toHaveLength(1);
    expect(await svc.recall(companyId, agentId, { tags: ["ops"], limit: 20 })).toHaveLength(1);
    const textHits = await svc.recall(companyId, agentId, { query: "stripe", limit: 20 });
    expect(textHits).toHaveLength(1);
    expect(textHits[0].title).toBe("Stripe key location");
  });

  it("does not leak memory across agents", async () => {
    const a = await seedCompanyAndAgent(db);
    const b = await seedCompanyAndAgent(db);
    await svc.write(a.companyId, a.agentId, { title: "A secret", body: "only for A" }, boardActor);
    expect(await svc.recall(b.companyId, b.agentId, { limit: 20 })).toHaveLength(0);
  });

  it("bumps recall stats on recall", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    await svc.write(companyId, agentId, { title: "T", body: "B" }, agentActor(agentId));
    await svc.recall(companyId, agentId, { limit: 20 });
    const after = await svc.list(companyId, agentId);
    expect(after[0].recallCount).toBe(1);
    expect(after[0].lastRecalledAt).not.toBeNull();
  });

  it("forgets a memory so it drops out of recall and active list", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const m = await svc.write(companyId, agentId, { title: "Temp", body: "ephemeral" }, boardActor);
    await svc.forget(companyId, agentId, m.id, boardActor);
    expect(await svc.recall(companyId, agentId, { limit: 20 })).toHaveLength(0);
    expect(await svc.list(companyId, agentId)).toHaveLength(0);
    expect(await svc.list(companyId, agentId, { includeForgotten: true })).toHaveLength(1);
  });

  it("corrects a memory by superseding the old one", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const original = await svc.write(companyId, agentId, { title: "Old fact", body: "wrong", tags: ["x"] }, boardActor);
    const corrected = await svc.correct(companyId, agentId, original.id, { title: "New fact", body: "right" }, boardActor);

    expect(corrected.supersedesMemoryId).toBe(original.id);
    const active = await svc.recall(companyId, agentId, { limit: 20 });
    expect(active).toHaveLength(1);
    expect(active[0].title).toBe("New fact");

    const all = await svc.list(companyId, agentId, { includeForgotten: true });
    const old = all.find((m) => m.id === original.id);
    expect(old?.status).toBe("forgotten");
    expect(old?.supersededByMemoryId).toBe(corrected.id);
  });

  it("redacts secret-looking values before persisting", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    const created = await svc.write(
      companyId,
      agentId,
      { title: "Key is sk-abcdefghijklmnopqrstuvwx", body: "token AKIAIOSFODNN7EXAMPLE here" },
      boardActor,
    );
    expect(created.title).not.toContain("sk-abcdefghijklmnopqrstuvwx");
    expect(created.body).toContain("[redacted-secret]");
  });

  it("renders an inspectable MEMORY.md grouped by type", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent(db);
    await svc.write(companyId, agentId, { type: "semantic", title: "Fact one", body: "f1" }, boardActor);
    await svc.write(companyId, agentId, { type: "lesson", title: "Lesson one", body: "l1" }, boardActor);
    const md = await svc.renderMarkdown(companyId, agentId);
    expect(md).toContain("# Memory");
    expect(md).toContain("## Facts");
    expect(md).toContain("## Lessons");
    expect(md).toContain("Fact one");
  });
});

describe("redactSecrets", () => {
  it("redacts common secret formats", () => {
    expect(redactSecrets("sk-abcdefghijklmnopqrstuvwx")).toBe("[redacted-secret]");
    expect(redactSecrets("plain text")).toBe("plain text");
  });
});
