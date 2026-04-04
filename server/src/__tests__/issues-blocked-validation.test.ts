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

  /** Helper: set the instance-level enforceBlockedOnValidation flag */
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

  /** Helper: set the company-level enforceBlockedOnValidation setting */
  async function setCompanySetting(enabled: boolean) {
    await db
      .update(companies)
      .set({ enforceBlockedOnValidation: enabled, updatedAt: new Date() })
      .where(eq(companies.id, companyId));
  }

  /** Helper: enable both instance flag and company setting */
  async function enableEnforcement() {
    await setEnforceFlag(true);
    await setCompanySetting(true);
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
    // Reset both instance flag and company setting
    await setEnforceFlag(false);
    await setCompanySetting(false);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("allows blocked transition when instance flag is off (passthrough)", async () => {
    await setEnforceFlag(false);
    const issue = await createTodoIssue("Flag off test");

    const result = await svc.update(issue.id, { status: "blocked" });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
  });

  it("allows blocked transition when instance flag is on but company setting is off", async () => {
    await setEnforceFlag(true);
    await setCompanySetting(false);
    const issue = await createTodoIssue("Company setting off");

    const result = await svc.update(issue.id, { status: "blocked" });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
  });

  it("allows blocked transition when instance flag is off but company setting is on (global kill switch)", async () => {
    await setEnforceFlag(false);
    await setCompanySetting(true);
    const issue = await createTodoIssue("Instance flag off override");

    const result = await svc.update(issue.id, { status: "blocked" });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
  });

  it("allows blocked transition when both enabled and blockedOn is in the request", async () => {
    await enableEnforcement();
    const issue = await createTodoIssue("BlockedOn in request");

    const result = await svc.update(issue.id, {
      status: "blocked",
      blockedOn: "board",
    });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
    expect(result!.blockedOn).toBe("board");
  });

  it("allows blocked transition when both enabled and blockedOn is already on the existing issue", async () => {
    await enableEnforcement();
    const issue = await createTodoIssue("BlockedOn on existing");

    // First set blockedOn without changing status
    await svc.update(issue.id, { blockedOn: "agent" });

    const result = await svc.update(issue.id, { status: "blocked" });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
    expect(result!.blockedOn).toBe("agent");
  });

  it("allows blocked transition when both enabled and a dependency edge exists", async () => {
    await enableEnforcement();
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

  it("rejects blocked transition when both enabled, no blockedOn, and no dependencies", async () => {
    await enableEnforcement();
    const issue = await createTodoIssue("No blockedOn or deps");

    await expect(svc.update(issue.id, { status: "blocked" })).rejects.toThrow(
      "Cannot transition to blocked without specifying blockedOn or having a dependency",
    );
  });

  it("does not validate when issue is already blocked (grandfathered)", async () => {
    // Create issue as blocked before turning on enforcement
    const issue = await createTodoIssue("Already blocked");
    await svc.update(issue.id, { status: "blocked" });

    // Turn on enforcement
    await enableEnforcement();

    // Updating other fields on an already-blocked issue should not trigger validation
    const result = await svc.update(issue.id, { title: "Still blocked" });
    expect(result).toBeTruthy();
    expect(result!.status).toBe("blocked");
    expect(result!.title).toBe("Still blocked");
  });
});
