import { setImmediate as immediate } from "node:timers/promises";
import { asc, eq } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { issues } from "@paperclipai/db";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";
import { seedRecoveryPopulation } from "./helpers/recovery-population.js";

const PASS = 25;

describeIssueRecovery("stranded-task checks read each company and agent fact once per pass", () => {
  const state = issueRecoveryFixture({ meter: true });

  async function measure(work: () => Promise<unknown>) {
    const before = state.meter.read();
    state.meter.startLog();
    await work();
    const log = state.meter.stopLog();
    const after = state.meter.read();
    return { statements: after.statements - before.statements, bytes: after.bytesReceived - before.bytesReceived,
      rows: after.rows - before.rows, log };
  }

  async function seed() {
    const f = await state.fixture();
    const population = await seedRecoveryPopulation(state.db, f.companyId, { agents: 50, inReview: 200 });
    return { ...f, population };
  }

  it("reads the agent, its reporting chain and the budget once per pass for a 50-agent, 200-task company", async () => {
    const { companyId } = await seed();
    const ordered = await state.db.select({ id: issues.id, agentId: issues.assigneeAgentId }).from(issues)
      .where(eq(issues.companyId, companyId)).orderBy(asc(issues.id));
    const tasks = ordered.map(row => row.id);
    const check = (issueId: string, pass: Map<string, unknown>) =>
      state.heartbeat.reconcileStrandedAssignedIssues({ companyId, issueId, pass, skipExternalConversationSettlement: true,
        skipRelatedRecovery: true } as Parameters<typeof state.heartbeat.reconcileStrandedAssignedIssues>[0]);

    await check(tasks[0]!, new Map());
    const single = await measure(() => check(tasks[1]!, new Map()));
    const pass = new Map<string, unknown>();
    const passReads = await measure(async () => { for (const issueId of tasks.slice(0, PASS)) await check(issueId, pass); });
    const companyAgentLists = passReads.log.filter(entry => /from "agents" where "agents"\."company_id" = \$1$/.test(entry.sql.trim()));
    const agentRows = passReads.log.filter(entry => /^select "id", "company_id", "name", "reports_to", "status".* from "agents" where "agents"\."id" = \$1$/.test(entry.sql.trim()));
    const budgetSnapshots = passReads.log.filter(entry => /^set transaction isolation level repeatable read read only/i.test(entry.sql.trim()));
    const writes = passReads.log.filter(entry => /^(insert|update|delete)/i.test(entry.sql.trim()));
    const distinctAgents = new Set(ordered.slice(0, PASS).map(row => row.agentId)).size;
    console.info(JSON.stringify({ singleCheck: { statements: single.statements, bytes: single.bytes, rows: single.rows },
      pass: { checks: PASS, statements: passReads.statements, bytes: passReads.bytes, rows: passReads.rows,
        perCheckStatements: passReads.statements / PASS, perCheckBytes: Math.round(passReads.bytes / PASS) },
      distinctAgents, companyAgentLists: companyAgentLists.length, agentRows: agentRows.length,
      budgetSnapshots: budgetSnapshots.length }));

    expect(writes).toEqual([]);
    expect(companyAgentLists).toEqual([]);
    expect(agentRows.length).toBeLessThanOrEqual(distinctAgents);
    expect(budgetSnapshots.length).toBeLessThanOrEqual(distinctAgents);
    expect(passReads.statements).toBeLessThan(single.statements * PASS);
    expect(passReads.bytes / PASS).toBeLessThan(10_000);
  }, 300_000);

  it("drains a full company load through the real worker with fewer statements and bytes per check", async () => {
    const { population } = await seed();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const drained = await measure(async () => {
      await state.start({});
      const until = Date.now() + 60_000;
      while (Date.now() < until) {
        await vi.advanceTimersByTimeAsync(500);
        await Promise.allSettled([...state.passes]); await immediate();
      }
    });
    const checks = drained.log.filter(entry => /from "case_handoffs"/.test(entry.sql) && /"issues"\."id" = \$/.test(entry.sql)).length;
    const companyAgentLists = drained.log.filter(entry => /from "agents" where "agents"\."company_id" = \$1$/.test(entry.sql.trim()));
    console.info(JSON.stringify({ worker: { strandedChecks: checks, statements: drained.statements, bytes: drained.bytes,
      rows: drained.rows, perCheckStatements: drained.statements / Math.max(1, checks),
      perCheckBytes: Math.round(drained.bytes / Math.max(1, checks)), companyAgentLists: companyAgentLists.length } }));
    expect(checks).toBeGreaterThanOrEqual(population.inReview.length);
    expect(companyAgentLists).toEqual([]);
    expect(drained.bytes / checks).toBeLessThan(10_000);
  }, 600_000);
});
