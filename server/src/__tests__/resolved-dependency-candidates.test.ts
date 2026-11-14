import { and, eq, inArray, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { issueRelations, issues } from "@paperclipai/db";
import { resolvedDependencyCandidate } from "../services/recovery/work.js";
import { describeIssueRecovery, issueRecoveryFixture } from "./issue-recovery.test-fixture.js";

const earlierPredicate = sql`exists (select 1 from ${issueRelations} r where r.company_id = ${issues.companyId}
      and r.related_issue_id = ${issues.id} and r.type = 'blocks')
    and not exists (select 1 from ${issueRelations} r inner join ${issues} blocker
      on blocker.id = r.issue_id and blocker.company_id = r.company_id
      where r.company_id = ${issues.companyId} and r.related_issue_id = ${issues.id}
        and r.type = 'blocks' and blocker.status <> 'done')`;

describeIssueRecovery("resolved dependency candidates", () => {
  const state = issueRecoveryFixture();
  async function blockedGraph(companyId: string, agentId: string, count: number) {
    const blockers = await state.db.insert(issues).values([
      { companyId, title: "Open blocker", status: "in_progress", assigneeAgentId: agentId },
      { companyId, title: "Done blocker", status: "done" },
      { companyId, title: "Cancelled blocker", status: "cancelled" },
    ]).returning({ id: issues.id });
    const blocked = await state.db.insert(issues).values(Array.from({ length: count }, (_, index) => ({
      companyId, title: `Blocked ${index}`, status: "blocked", assigneeAgentId: agentId,
    }))).returning({ id: issues.id });
    const relations = blocked.flatMap((row, index) => {
      const shape = index % 4;
      if (shape === 0) return [{ blocker: 1, row }];
      if (shape === 1) return [{ blocker: 0, row }];
      if (shape === 2) return [{ blocker: 1, row }, { blocker: 2, row }];
      return [];
    }).map(({ blocker, row }) => ({ companyId, issueId: blockers[blocker].id, relatedIssueId: row.id, type: "blocks" as const }));
    for (let index = 0; index < relations.length; index += 500) await state.db.insert(issueRelations).values(relations.slice(index, index + 500));
  }
  const candidates = (companyId: string, predicate: ReturnType<typeof sql>) => state.db.select({ id: issues.id }).from(issues)
    .where(and(eq(issues.companyId, companyId), inArray(issues.status, ["blocked"]), predicate)).orderBy(issues.id);
  it("selects the same tasks as the earlier predicate", async () => {
    const f = await state.fixture();
    await blockedGraph(f.companyId, f.agentId, 40);
    const current = await candidates(f.companyId, resolvedDependencyCandidate);
    expect(current).toEqual(await candidates(f.companyId, earlierPredicate));
    expect(current).toHaveLength(10);
  });
  it("probes the relations of each task, whatever the planner statistics say", async () => {
    const small = await state.fixture();
    await blockedGraph(small.companyId, small.agentId, 8);
    await state.db.execute(sql`analyze issues`);
    await state.db.execute(sql`analyze issue_relations`);
    const large = await state.fixture();
    await blockedGraph(large.companyId, large.agentId, 3000);
    const query = candidates(large.companyId, resolvedDependencyCandidate).limit(100).toSQL();
    const [{ "QUERY PLAN": plan }] = await state.db.$client.unsafe(`explain (format json) ${query.sql}`, query.params as never[]) as Array<{ "QUERY PLAN": unknown }>;
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/"Join Type":"(Semi|Anti)"/);
    expect(text.match(/"Subplan Name"/g)).toHaveLength(2);
    const rows = await state.db.transaction(async tx => {
      await tx.execute(sql`set local statement_timeout = '5s'`);
      return tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, large.companyId),
        inArray(issues.status, ["blocked"]), resolvedDependencyCandidate)).limit(100);
    });
    expect(rows).toHaveLength(100);
  });
});
