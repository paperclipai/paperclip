import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { runRbr767Sweep } from "../scripts/rbr767-sweep.js";

/**
 * RBR-804 AC5: a zero-agent-era issue drains through the *existing* sweep path.
 *
 * The create route no longer refuses when a company has no agents -- it writes the issue
 * unassigned and flags it `no_agents_in_company`. That flag has to be more than a label:
 * the row must actually acquire an owner once someone is hired, through the same machinery
 * that drains `no_invokable_owner` rows. No new machinery, one ladder, one sweep.
 *
 * The shape under test is hire-then-sweep:
 *   1. An issue exists with no assignee and `assignee_fallback_reason = no_agents_in_company`
 *      (the record the bootstrap create leaves behind).
 *   2. With zero agents the sweep finds it, reports NO OWNER POSSIBLE, and leaves it flagged.
 *   3. The first agent is hired.
 *   4. The next sweep assigns that agent AND clears the flag, so the worklist drains.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres RBR-767 sweep drain tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres("rbr767 sweep: zero-agent-era issues drain on first hire", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-rbr767-sweep-drain-");
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

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Bootstrap Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 5).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function hire(companyId: string, name: string, reportsTo: string | null = null) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo,
    });
    return agentId;
  }

  /** The record the bootstrap create path leaves behind in an empty company. */
  async function seedZeroAgentEraIssue(companyId: string, title: string) {
    const [row] = await db.insert(issues).values({
      companyId,
      title,
      status: "todo",
      priority: "high",
      assigneeAgentId: null,
      assigneeUserId: null,
      assigneeFallbackReason: "no_agents_in_company",
    }).returning();
    return row;
  }

  it("hire-then-sweep: assigns the first hire and clears the flag", async () => {
    const companyId = await seedCompany();
    const issue = await seedZeroAgentEraIssue(companyId, "Hire the first agent");

    // Still zero agents: the row is found, reported, and left flagged. Nothing is lost.
    const beforeHire = await runRbr767Sweep(db, { companyId, apply: true });
    expect(beforeHire.scanned).toBe(1);
    expect(beforeHire.repaired).toBe(0);
    expect(beforeHire.failed).toBe(1);
    expect(beforeHire.lines.join("\n")).toMatch(/NO OWNER POSSIBLE \(no_agents_in_company\)/);

    const [stillFlagged] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(stillFlagged.assigneeAgentId).toBeNull();
    expect(stillFlagged.assigneeFallbackReason).toBe("no_agents_in_company");

    // First hire. The roster now has exactly one invokable agent, and it is the root.
    const ceo = await hire(companyId, "First CEO", null);

    const afterHire = await runRbr767Sweep(db, { companyId, apply: true });
    expect(afterHire.scanned).toBe(1);
    expect(afterHire.repaired).toBe(1);
    expect(afterHire.failed).toBe(0);

    const [drained] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(drained.assigneeAgentId).toBe(ceo);
    // Clearing the flag is what drains the worklist -- an owned row must not be re-swept.
    expect(drained.assigneeFallbackReason).toBeNull();

    const finalSweep = await runRbr767Sweep(db, { companyId, apply: true });
    expect(finalSweep.scanned).toBe(0);
    expect(finalSweep.lines.join("\n")).toMatch(/SWEEP CLEAN/);
  });

  it("drains no_agents_in_company and no_invokable_owner through the identical path", async () => {
    const companyId = await seedCompany();
    // A paused root: the roster exists but nothing is invokable, so the create path wrote
    // an owner and flagged it `no_invokable_owner`.
    const pausedRoot = randomUUID();
    await db.insert(agents).values({
      id: pausedRoot,
      companyId,
      name: "Paused root",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
      reportsTo: null,
    });
    const [degraded] = await db.insert(issues).values({
      companyId,
      title: "Filed while the roster was down",
      status: "todo",
      priority: "high",
      assigneeAgentId: pausedRoot,
      assigneeFallbackReason: "no_invokable_owner",
    }).returning();
    const zeroAgentEra = await seedZeroAgentEraIssue(companyId, "Filed before anyone was hired");

    // Roster recovers: the paused root comes back.
    await db.update(agents).set({ status: "active" }).where(eq(agents.id, pausedRoot));

    const sweep = await runRbr767Sweep(db, { companyId, apply: true });
    expect(sweep.scanned).toBe(2);
    expect(sweep.repaired).toBe(2);
    expect(sweep.failed).toBe(0);

    for (const id of [degraded.id, zeroAgentEra.id]) {
      const [row] = await db.select().from(issues).where(eq(issues.id, id));
      expect(row.assigneeAgentId).toBe(pausedRoot);
      expect(row.assigneeFallbackReason).toBeNull();
    }
  });

  it("dry run reports the drain without writing it", async () => {
    const companyId = await seedCompany();
    const issue = await seedZeroAgentEraIssue(companyId, "Dry run target");
    const ceo = await hire(companyId, "First CEO", null);

    const dry = await runRbr767Sweep(db, { companyId, apply: false });
    expect(dry.repaired).toBe(1);
    expect(dry.lines.join("\n")).toMatch(/dry run/);

    const [untouched] = await db.select().from(issues).where(eq(issues.id, issue.id));
    expect(untouched.assigneeAgentId).toBeNull();
    expect(untouched.assigneeFallbackReason).toBe("no_agents_in_company");
    expect(ceo).toBeTruthy();
  });

  it("does not re-sweep a terminal zero-agent-era issue", async () => {
    const companyId = await seedCompany();
    await db.insert(issues).values({
      companyId,
      title: "Cancelled before anyone was hired",
      status: "cancelled",
      priority: "low",
      assigneeAgentId: null,
      assigneeFallbackReason: "no_agents_in_company",
    });
    await hire(companyId, "First CEO", null);

    const sweep = await runRbr767Sweep(db, { companyId, apply: true });
    expect(sweep.scanned).toBe(0);
  });
});
