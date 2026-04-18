import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  instanceSettings,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

describeEmbeddedPostgres("issueService priority normalization", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-service-priority-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("normalizes legacy urgent priority on direct service create", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    const created = await svc.create(companyId, {
      title: "Recover cart issue creation",
      priority: "urgent" as never,
    });

    expect(created.priority).toBe("critical");
  });

  it("normalizes legacy urgent priority on direct service update", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "PrivateClip",
      issuePrefix: "TST",
      requireBoardApprovalForNewAgents: false,
    });

    const created = await svc.create(companyId, {
      title: "Recover cart issue update",
      priority: "medium",
    });

    const updated = await svc.update(created.id, {
      priority: "urgent" as never,
    });

    expect(updated?.priority).toBe("critical");
  });
});
