import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  instanceSettings,
  issueDependencies,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres blocked-validation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService blockedOn validation", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const companyId = randomUUID();
  const agentId = randomUUID();

  /** Helper: set the enforceBlockedOnValidation flag */
  async function setEnforceFlag(enabled: boolean) {
    const rows = await db.select().from(instanceSettings);
    if (rows.length === 0) {
      await db.insert(instanceSettings).values({
        singletonKey: "default",
        general: {},
        experimental: { enforceBlockedOnValidation: enabled },
      });
    } else {
      await db
        .update(instanceSettings)
        .set({
          experimental: { enforceBlockedOnValidation: enabled },
          updatedAt: new Date(),
        })
        .where(eq(instanceSettings.id, rows[0].id));
    }
  }

  /** Helper: create a todo issue assigned to the test agent */
  async function createTodoIssue(title: string) {
    const [row] = await db
      .insert(issues)
      .values({
        companyId,
        title,
        status: "todo",
        priority: "medium",
        assigneeAgentId: agentId,
      })
      .returning();
    return row;
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-val-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);

    await db.insert(companies).values({
      id: companyId,
      name: "TestCo",
      issuePrefix: "BLK",
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "running",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueDependencies);
    await db.delete(issues);
    // Reset flag to off after each test
    await setEnforceFlag(false);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows blocked transition when flag is off (passthrough)", async () => {
    await setEnforceFlag(false);
    const issue = await createTodoIssue("Flag off test");

    const result = await svc.update(issue.id, { status: "blocked" });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
  });

  it("allows blocked transition when flag is on and blockedOn is in the request", async () => {
    await setEnforceFlag(true);
    const issue = await createTodoIssue("BlockedOn in request");

    const result = await svc.update(issue.id, {
      status: "blocked",
      blockedOn: "board",
    });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
    expect(result!.blockedOn).toBe("board");
  });

  it("allows blocked transition when flag is on and blockedOn is already on the existing issue", async () => {
    await setEnforceFlag(true);
    const issue = await createTodoIssue("BlockedOn on existing");

    // First set blockedOn without changing status
    await svc.update(issue.id, { blockedOn: "agent" });

    const result = await svc.update(issue.id, { status: "blocked" });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
    expect(result!.blockedOn).toBe("agent");
  });

  it("allows blocked transition when flag is on and a dependency edge exists", async () => {
    await setEnforceFlag(true);
    const issue = await createTodoIssue("Has dependency");
    const blockerIssue = await createTodoIssue("Blocker issue");

    // Insert a dependency edge
    await db.insert(issueDependencies).values({
      companyId,
      issueId: issue.id,
      blockerIssueId: blockerIssue.id,
    });

    const result = await svc.update(issue.id, { status: "blocked" });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
  });

  it("rejects blocked transition when flag is on, no blockedOn, and no dependencies", async () => {
    await setEnforceFlag(true);
    const issue = await createTodoIssue("No blockedOn or deps");

    await expect(svc.update(issue.id, { status: "blocked" })).rejects.toThrow(
      "Cannot transition to blocked without specifying blockedOn or having a dependency",
    );
  });

  it("does not validate when issue is already blocked (grandfathered)", async () => {
    // Create issue as blocked before turning on the flag
    await setEnforceFlag(false);
    const issue = await createTodoIssue("Already blocked");
    await svc.update(issue.id, { status: "blocked" });

    // Turn on the flag
    await setEnforceFlag(true);

    // Updating other fields on an already-blocked issue should not trigger validation
    const result = await svc.update(issue.id, { title: "Still blocked" });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
    expect(result!.title).toBe("Still blocked");
  });
});
