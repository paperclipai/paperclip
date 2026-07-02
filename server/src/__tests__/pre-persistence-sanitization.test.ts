import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  companies,
  createDb,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { logActivity } from "../services/activity-log.js";
import { issueService } from "../services/issues.js";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres pre-persistence sanitization tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// Fake canary values only — shaped like credentials, never real ones.
const CANARY = "canary-fake-value-000";
const CANARY_GITHUB_SHAPED = "ghp_canaryFAKE00000000000000";

describeEmbeddedPostgres("pre-persistence sanitization", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pre-persist-sanitize-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue() {
    const companyId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Sanitize Before Persist Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "SAN-1",
      title: "Pre-persistence sanitization",
      status: "todo",
      priority: "medium",
    });
    return { companyId, issueId };
  }

  it("sanitizes credential-shaped comment text before the row is written", async () => {
    const { issueId } = await seedIssue();

    await issueService(db).addComment(
      issueId,
      `Reproduced with MY_API_TOKEN=${CANARY} and pushed using ${CANARY_GITHUB_SHAPED}.`,
      { userId: "user-1" },
    );

    const [row] = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(row).toBeDefined();
    expect(row!.body).not.toContain(CANARY);
    expect(row!.body).not.toContain(CANARY_GITHUB_SHAPED);
    expect(row!.body).toContain(REDACTED_EVENT_VALUE);
  });

  it("keeps ordinary comment text intact at rest", async () => {
    const { issueId } = await seedIssue();
    const body = "Deployed version 1.2.3 to production and verified the dashboard.";

    await issueService(db).addComment(issueId, body, { userId: "user-1" });

    const [row] = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(row!.body).toBe(body);
  });

  it("sanitizes nested activity payloads before the row is written", async () => {
    const { companyId, issueId } = await seedIssue();

    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: issueId,
      details: {
        apiKey: CANARY,
        env: { SERVICE_ACCESS_TOKEN: { type: "plain", value: CANARY } },
        notes: [`command ran with EXPORTED_API_TOKEN=${CANARY}`],
        durationMs: 42,
      },
    });

    const [row] = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
    expect(row).toBeDefined();
    const details = row!.details as Record<string, unknown>;
    expect(JSON.stringify(details)).not.toContain(CANARY);
    expect(details.apiKey).toBe(REDACTED_EVENT_VALUE);
    expect(details.durationMs).toBe(42);
  });
});
