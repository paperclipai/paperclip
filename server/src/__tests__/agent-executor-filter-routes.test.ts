/**
 * Phase-4 4b-3 — Agent list executor-filter (service-level integration).
 *
 * Verifies agentService.list({executor}) filters DB rows correctly.
 * Route-level wiring (400 on invalid query, query-param plumbing) is covered
 * inline in agents.ts; deep mocking of the agents route is impractical due
 * to many helper-service dependencies.
 */
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

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping executor-filter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("agentService.list executor filter (Phase-4 4b-3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-executor-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "test-co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
  }

  async function seedAgent(executor: "hermes" | "mc-dispatch", name: string) {
    await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name,
      role: "engineer",
      status: "running",
      executor,
      adapterType: "codex_local",
    });
  }

  it("no filter returns all agents", async () => {
    await seedCompany();
    await seedAgent("hermes", "h1");
    await seedAgent("mc-dispatch", "m1");

    const all = await agentService(db).list(companyId);
    expect(all.length).toBe(2);
  });

  it("executor=hermes returns only hermes agents", async () => {
    await seedCompany();
    await seedAgent("hermes", "h1");
    await seedAgent("hermes", "h2");
    await seedAgent("mc-dispatch", "m1");

    const hermes = await agentService(db).list(companyId, { executor: "hermes" });
    expect(hermes.length).toBe(2);
    expect(hermes.every((a) => a.executor === "hermes")).toBe(true);
  });

  it("executor=mc-dispatch returns only mc-dispatch agents", async () => {
    await seedCompany();
    await seedAgent("hermes", "h1");
    await seedAgent("mc-dispatch", "m1");

    const md = await agentService(db).list(companyId, { executor: "mc-dispatch" });
    expect(md.length).toBe(1);
    expect(md[0]?.executor).toBe("mc-dispatch");
    expect(md[0]?.name).toBe("m1");
  });

  it("executor filter with includeTerminated=false skips terminated", async () => {
    await seedCompany();
    await seedAgent("hermes", "h1");
    await db.insert(agents).values({
      id: randomUUID(),
      companyId,
      name: "h-dead",
      role: "engineer",
      status: "terminated",
      executor: "hermes",
      adapterType: "codex_local",
    });

    const hermes = await agentService(db).list(companyId, { executor: "hermes" });
    expect(hermes.length).toBe(1);
    expect(hermes[0]?.name).toBe("h1");
  });

  it("isolates by companyId", async () => {
    await seedCompany();
    await seedAgent("hermes", "h1");
    const otherCompany = randomUUID();
    await db.insert(companies).values({
      id: otherCompany,
      name: "other-co",
      issuePrefix: "O",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: randomUUID(),
      companyId: otherCompany,
      name: "other-hermes",
      role: "engineer",
      status: "running",
      executor: "hermes",
      adapterType: "codex_local",
    });

    const ourHermes = await agentService(db).list(companyId, { executor: "hermes" });
    expect(ourHermes.length).toBe(1);
    expect(ourHermes[0]?.name).toBe("h1");
  });
});
