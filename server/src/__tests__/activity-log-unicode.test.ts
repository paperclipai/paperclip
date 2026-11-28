import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, companies, createDb } from "@paperclipai/db";
import { logActivity, type ActivityPublication } from "../services/activity-log.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("logActivity unicode details", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-unicode-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function record(details: Record<string, unknown>) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `U${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const publications: ActivityPublication[] = [];
    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "user-1",
      action: "issue.comment_added",
      entityType: "company",
      entityId: companyId,
      details,
    }, publications);
    const row = await db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.companyId, companyId))
      .then((rows) => rows[0]);
    return { stored: row?.details, published: publications[0]?.payload.details };
  }

  it("stores a snippet that ends inside a surrogate pair", async () => {
    const body = `${"a".repeat(119)}\u{1F4C1} rest`;
    const { stored, published } = await record({
      bodySnippet: body.slice(0, 120),
      lowFirst: "\udc01x",
      pair: "ok \u{1F4C1}",
      nested: { items: ["\ud83d", { "k\ud83d": "v" }], count: 3, flag: true, none: null },
    });

    const expected = {
      bodySnippet: `${"a".repeat(119)}\ufffd`,
      lowFirst: "\ufffdx",
      pair: "ok \u{1F4C1}",
      nested: { items: ["\ufffd", { "k\ufffd": "v" }], count: 3, flag: true, none: null },
    };
    expect(stored).toEqual(expected);
    expect(published).toEqual(expected);
  });

  it("leaves well-formed details unchanged", async () => {
    const details = {
      bodySnippet: "plain \u{1F4C1} text",
      nested: { items: ["a", 1, false, null], label: "\u00e9" },
      at: new Date("2026-10-21T00:00:00.000Z"),
    };
    const { stored, published } = await record(details);

    expect(stored).toEqual(JSON.parse(JSON.stringify(details)));
    expect(JSON.stringify(published)).toBe(JSON.stringify(details));
  });
});
