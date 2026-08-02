import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue capability routing tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue capability-aware routing", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-capability-routing-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    await db.execute(sql.raw(`TRUNCATE TABLE "companies" CASCADE`));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCapabilityCompany() {
    const companyId = randomUUID();
    const coderId = randomUUID();
    const designerId = randomUUID();
    const issuePrefix = `TC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "ThinkStack",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: coderId,
        companyId,
        name: "Backend Coder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: designerId,
        companyId,
        name: "Designer-Media",
        title: "Designer / Media (grok-imagine)",
        role: "engineer",
        status: "active",
        adapterType: "hermes_local",
        adapterConfig: { toolsets: "image_gen,video_gen", routingToolsets: "tts_gen" },
        runtimeConfig: {},
        permissions: {},
      },
    ]);

    return { companyId, coderId, designerId };
  }

  it("rejects media issue creation when assigned to a tool-less agent", async () => {
    const { companyId, coderId, designerId } = await seedCapabilityCompany();

    await expect(svc.create(companyId, {
      title: "Generate launch hero image",
      description: "Requires image_gen output for the landing page.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: coderId,
    })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        assigneeAgentId: coderId,
        requiredToolsets: ["image_gen"],
        suggestedAgentIds: [designerId],
      }),
    });
  });

  it("rejects reassigning media work to a tool-less agent on update", async () => {
    const { companyId, coderId, designerId } = await seedCapabilityCompany();
    const created = await svc.create(companyId, {
      title: "Generate launch hero image",
      description: "Requires image_gen output for the landing page.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: designerId,
    });

    await expect(svc.update(created.id, {
      assigneeAgentId: coderId,
    })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        assigneeAgentId: coderId,
        requiredToolsets: ["image_gen"],
      }),
    });
  });

  it("rejects fallback reassignment to a sister without the required media tools", async () => {
    const { companyId, coderId, designerId } = await seedCapabilityCompany();
    const created = await svc.create(companyId, {
      title: "Generate launch hero image",
      description: "Requires image_gen output for the landing page.",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: designerId,
    });

    await expect(svc.fallbackReassign(
      {
        id: created.id,
        companyId,
        identifier: created.identifier,
        assigneeAgentId: designerId,
      },
      { id: coderId },
      "usage_limit",
      null,
      null,
    )).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        assigneeAgentId: coderId,
        requiredToolsets: ["image_gen"],
      }),
    });

    const storedIssue = await db
      .select({ assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(eq(issues.id, created.id))
      .then((rows) => rows[0]!);
    expect(storedIssue.assigneeAgentId).toBe(designerId);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, created.id));
    expect(comments).toHaveLength(0);
  });

  it("routes explicit tts_gen work to the lane that advertises routing-only toolsets", async () => {
    const { companyId, coderId, designerId } = await seedCapabilityCompany();

    await expect(svc.create(companyId, {
      title: "Narrate launch script",
      description: "requires: tts_gen voiceover for the approved script.",
      status: "todo",
      priority: "medium",
      assigneeAgentId: coderId,
    })).rejects.toMatchObject({
      status: 422,
      details: expect.objectContaining({
        assigneeAgentId: coderId,
        requiredToolsets: ["tts_gen"],
        suggestedAgentIds: [designerId],
      }),
    });
  });
});
