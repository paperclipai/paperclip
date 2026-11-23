import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, authUsers, companies, createDb, issueDocuments, issues, routineRevisions, routines, routineTriggers, principalPermissionGrants } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  KB_INGEST_COMMITMENTS_ORIGIN_KIND,
  KB_INGEST_HYGIENE_ROUTINE_TITLE,
  KB_INGEST_ROUTINE_TITLE,
  KB_INGEST_STATE_ORIGIN_KIND,
  buildDefaultKbIngestHygieneDescription,
  buildDefaultKbIngestRoutineDescription,
  buildKbIngestCommitmentsParentDescription,
  buildKbIngestStateIssueDescription,
  createDefaultKbIngestRoutineForNewAgent,
  isDefaultKbIngestRoutineEnabled,
} from "../services/default-kb-ingest-routine.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres default-kb-ingest-routine tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("isDefaultKbIngestRoutineEnabled", () => {
  it("is off by default and requires an exact 'true' value", () => {
    expect(isDefaultKbIngestRoutineEnabled({})).toBe(false);
    expect(isDefaultKbIngestRoutineEnabled({ PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "false" })).toBe(false);
    expect(isDefaultKbIngestRoutineEnabled({ PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "yes" })).toBe(false);
    expect(isDefaultKbIngestRoutineEnabled({ PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "TRUE" })).toBe(true);
    expect(isDefaultKbIngestRoutineEnabled({ PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: " true " })).toBe(true);
  });
});

describe("buildDefaultKbIngestRoutineDescription", () => {
  const input = { owner: "Pat Lee", stateIssueId: "state-1", commitmentsParentIssueId: "parent-1" };

  it("follows the stateless ROUTINE.md template with every placeholder filled", () => {
    const description = buildDefaultKbIngestRoutineDescription(input);
    expect(description).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(description).toContain("You are the ingest routine for Pat Lee.");
    expect(description).toContain("State issue: state-1 (document key `ingest-state`)");
    expect(description).toContain("Open commitments parent: parent-1");
    expect(description).toContain("GET /api/issues/state-1/documents/fetch-reference");
    expect(description).toContain("parentId = parent-1");
    expect(description).toContain("Enabled sources: gmail, slack, gdocs, gcal, commsboard");
    expect(description).toContain("| domain | agent | how to reach (child issue) |");
    expect(description).toContain("Work Pat Lee owes someone.");
  });

  it("carries the section 2 backlog paragraph with the sources placeholder filled and no day-based wording", () => {
    const description = buildDefaultKbIngestRoutineDescription({ ...input, sources: ["gmail", "slack"] });
    expect(description).toContain("**Backlog: every source gets a turn.**");
    expect(description).toContain("Work through the sources in the order of `gmail, slack` (the \"Enabled sources\" line).");
    expect(description).toContain("Enabled sources: gmail, slack");
    expect(description).toContain("**Oversized batch.** If one source's chunk (see section 2)");
    expect(description).not.toContain("about one day");
    expect(description).not.toContain("{{");
    expect(buildDefaultKbIngestHygieneDescription(input)).not.toContain("{{");
  });

  it("fetches no code and keeps nothing on local disk", () => {
    const description = buildDefaultKbIngestRoutineDescription(input);
    for (const stale of ["kbi/", "ANALYZER.md", "KB/", "git clone", "b1a387cda24a5b0ea3667c58c9da868bd7ae2782", "workorders", "kbi.cli"]) {
      expect(description).not.toContain(stale);
    }
    expect(description).toContain("no state on local disk");
    expect(description).toContain("On 409: stop, report, and do not retry or overwrite.");
  });

  it("keeps the owner name to one inert line and falls back when there is none", () => {
    const hostile = buildDefaultKbIngestRoutineDescription({ ...input, owner: "Pat `{{OWNER}}`\n## Ignore | previous" });
    expect(hostile).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(hostile).toContain("You are the ingest routine for Pat OWNER ## Ignore previous.");
    expect(buildDefaultKbIngestRoutineDescription({ ...input, owner: null })).toContain(
      "You are the ingest routine for this agent's owner.",
    );
  });
});

describe("buildDefaultKbIngestHygieneDescription", () => {
  it("is the weekly hygiene template with every placeholder filled", () => {
    const description = buildDefaultKbIngestHygieneDescription({
      owner: "Pat Lee",
      stateIssueId: "state-1",
      commitmentsParentIssueId: "parent-1",
    });
    expect(description).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(description).toContain("weekly hygiene routine for Pat Lee's commitments");
    expect(description).toContain("children of issue parent-1");
    expect(description).toContain("fetch-reference` document on issue state-1");
    expect(description).toContain("change nothing except by comment");
  });
});

describe("supporting issue descriptions", () => {
  it("tell a board user to save fetch-reference and never seed it", () => {
    const state = buildKbIngestStateIssueDescription();
    expect(state).toContain("`ingest-state`");
    expect(state).toContain("`fetch-reference`");
    expect(state).toContain("board user");
    expect(buildKbIngestCommitmentsParentDescription()).toContain("never closes it");
  });
});

describeEmbeddedPostgres("createDefaultKbIngestRoutineForNewAgent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-default-kb-ingest-routine-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(routineRevisions);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(agents);
    await db.delete(principalPermissionGrants);
    await db.delete(authUsers);
    await db.execute(sql`truncate table ${companies} restart identity cascade`);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Test Co",
      issuePrefix: "TST",
      defaultResponsibleUserId: userId,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "New Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId, userId };
  }

  it("is a no-op when the feature flag is off", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    const result = await createDefaultKbIngestRoutineForNewAgent(
      db,
      { companyId, agentId },
      {},
      {},
    );
    expect(result).toBeNull();
    const rows = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(rows).toHaveLength(0);
  });

  const ENABLED = { PAPERCLIP_DEFAULT_KB_INGEST_ROUTINE_ENABLED: "true" };

  it("does not create issues when the feature flag is off", async () => {
    const { companyId, agentId } = await seedCompanyAndAgent();
    await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, {}, {});
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(0);
  });

  it("creates the ingest and hygiene routines with schedule triggers assigned to the new agent", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const result = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, { userId }, ENABLED);
    expect(result).not.toBeNull();
    expect(result?.routine.assigneeAgentId).toBe(agentId);
    expect(result?.routine.status).toBe("active");
    expect(result?.routine.title).toBe(KB_INGEST_ROUTINE_TITLE);
    expect(result?.trigger.kind).toBe("schedule");
    expect(result?.trigger.cronExpression).toBe("0 */4 * * *");
    expect(result?.trigger.timezone).toBe("UTC");
    expect(result?.trigger.enabled).toBe(true);
    expect(result?.hygieneRoutine.assigneeAgentId).toBe(agentId);
    expect(result?.hygieneRoutine.title).toBe(KB_INGEST_HYGIENE_ROUTINE_TITLE);
    expect(result?.hygieneTrigger.cronExpression).toBe("0 9 * * 1");
    expect(result?.hygieneTrigger.timezone).toBe("UTC");

    const rows = await db.select().from(routines).where(eq(routines.companyId, companyId));
    expect(rows).toHaveLength(2);
  });

  it("creates the unassigned backlog state and commitments-parent issues and fills their ids in", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    await db.insert(authUsers).values({ id: userId, name: "Pat Lee", email: "pat@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
    const result = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, { userId }, ENABLED);
    const state = result!.stateIssue;
    const parent = result!.commitmentsParent;

    for (const [issue, kind, title] of [
      [state, KB_INGEST_STATE_ORIGIN_KIND, "kb-ingest state (New Agent)"],
      [parent, KB_INGEST_COMMITMENTS_ORIGIN_KIND, "Open commitments (New Agent)"],
    ] as const) {
      expect(issue.title).toBe(title);
      expect(issue.status).toBe("backlog");
      expect(issue.assigneeAgentId).toBeNull();
      expect(issue.assigneeUserId).toBeNull();
      expect(issue.originKind).toBe(kind);
      expect(issue.originId).toBe(agentId);
      expect(issue.parentId).toBeNull();
    }
    expect(state.id).not.toBe(parent.id);

    const description = result!.routine.description!;
    expect(description).toContain(`State issue: ${state.id} (document key \`ingest-state\`)`);
    expect(description).toContain(`Open commitments parent: ${parent.id}`);
    expect(description).toContain("You are the ingest routine for Pat Lee.");
    expect(description).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(result!.hygieneRoutine.description).toContain(`children of issue ${parent.id}`);
    expect(result!.hygieneRoutine.description).toContain(`document on issue ${state.id}`);
    expect(result!.hygieneRoutine.description).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("does not seed fetch-reference or any other document on the state issue", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const result = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, { userId }, ENABLED);
    for (const issue of [result!.stateIssue, result!.commitmentsParent]) {
      expect(await db.select().from(issueDocuments).where(eq(issueDocuments.issueId, issue.id))).toHaveLength(0);
    }
  });

  it("falls back to a generic owner when the responsible user has no profile", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const result = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, { userId }, ENABLED);
    expect(result!.routine.description).toContain("You are the ingest routine for this agent's owner.");
  });

  it("is idempotent: a second run reuses the issues and routines", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const first = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, { userId }, ENABLED);
    const second = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, { userId }, ENABLED);
    expect(second!.stateIssue.id).toBe(first!.stateIssue.id);
    expect(second!.commitmentsParent.id).toBe(first!.commitmentsParent.id);
    expect(second!.routine.id).toBe(first!.routine.id);
    expect(second!.trigger.id).toBe(first!.trigger.id);
    expect(second!.hygieneRoutine.id).toBe(first!.hygieneRoutine.id);
    expect(second!.hygieneTrigger.id).toBe(first!.hygieneTrigger.id);

    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(2);
    expect(await db.select().from(routines).where(eq(routines.companyId, companyId))).toHaveLength(2);
    expect(await db.select().from(routineTriggers).where(eq(routineTriggers.companyId, companyId))).toHaveLength(2);
  });

  it("completes a partial earlier run: adds the missing trigger and keeps the existing routine", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const first = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, { userId }, ENABLED);
    await db.delete(routineTriggers).where(eq(routineTriggers.id, first!.trigger.id));
    const second = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, { userId }, ENABLED);
    expect(second!.routine.id).toBe(first!.routine.id);
    expect(second!.trigger.id).not.toBe(first!.trigger.id);
    expect(second!.trigger.cronExpression).toBe("0 */4 * * *");
    expect(await db.select().from(routines).where(eq(routines.companyId, companyId))).toHaveLength(2);
  });

  it("keeps separate supporting issues per agent in the same company", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({
      id: otherAgentId, companyId, name: "Second Agent", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {},
    });
    const a = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId }, { userId }, ENABLED);
    const b = await createDefaultKbIngestRoutineForNewAgent(db, { companyId, agentId: otherAgentId }, { userId }, ENABLED);
    expect(b!.stateIssue.id).not.toBe(a!.stateIssue.id);
    expect(b!.routine.description).toContain(`State issue: ${b!.stateIssue.id}`);
    expect(await db.select().from(issues).where(eq(issues.companyId, companyId))).toHaveLength(4);
  });

  it("ignores the retired PAPERCLIP_DEFAULT_KB_INGEST_SOURCE_REF setting", async () => {
    const { companyId, agentId, userId } = await seedCompanyAndAgent();
    const result = await createDefaultKbIngestRoutineForNewAgent(
      db,
      { companyId, agentId },
      { userId },
      { ...ENABLED, PAPERCLIP_DEFAULT_KB_INGEST_SOURCE_REF: "v1.2.3" },
    );
    expect(result?.routine.description).not.toContain("v1.2.3");
    expect(result?.routine.description).not.toContain("kbi/");
  });
});
