import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { ensureCeoChatIssue } from "./ceo-chat.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres CEO chat service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("ensureCeoChatIssue", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-ceo-chat-service-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndCeo() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Test Company ${companyId}`,
      issuePrefix: `C${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });

    const ceoId = randomUUID();
    await db.insert(agents).values({
      id: ceoId,
      companyId,
      name: "CEO Agent",
      role: "ceo",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    return { companyId, ceoId };
  }

  it("creates a CEO chat issue when none exists", async () => {
    const { companyId, ceoId } = await seedCompanyAndCeo();

    const result = await ensureCeoChatIssue(db, companyId, ceoId);

    expect(result.isCeoChat).toBe(true);
    expect(result.companyId).toBe(companyId);
    expect(result.assigneeAgentId).toBe(ceoId);
    expect(result.status).toBe("in_progress");
    expect(result.title).toBe("CEO Chat");
    expect(result.id).toBeTruthy();
  });

  it("is idempotent — returns the existing issue when called twice", async () => {
    const { companyId, ceoId } = await seedCompanyAndCeo();

    const first = await ensureCeoChatIssue(db, companyId, ceoId);
    const second = await ensureCeoChatIssue(db, companyId, ceoId);

    expect(second.id).toBe(first.id);

    const allChatIssues = await db
      .select()
      .from(issues)
      .then((rows) => rows.filter((r) => r.companyId === companyId && r.isCeoChat));
    expect(allChatIssues).toHaveLength(1);
  });

  it("refuses to seed a chat for a non-CEO agent", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Test Company ${companyId}`,
      issuePrefix: `D${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });

    const engineerId = randomUUID();
    await db.insert(agents).values({
      id: engineerId,
      companyId,
      name: "Engineer Agent",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await expect(ensureCeoChatIssue(db, companyId, engineerId)).rejects.toThrow(/not a ceo/i);
  });
});
