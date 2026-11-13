import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, not, sql } from "drizzle-orm";
import { agents, approvals, companies, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { isHeartbeatRunVisibleInMine, latestFailedRunsByAgent } from "@paperclipai/shared";
import type { sidebarBadgeService } from "../../services/sidebar-badges.js";

export type BadgeOptions = Parameters<ReturnType<typeof sidebarBadgeService>["get"]>[1];
export type CapturedQuery = { sql: string; params: unknown[] };

export function captureSidebarQueries(db: Db, queries: CapturedQuery[]): Db {
  return new Proxy(db, { get(target, key) {
    if (key !== "select") return Reflect.get(target, key);
    return (...fields: Parameters<Db["select"]>) => {
      const builder = target.select(...fields), from = builder.from.bind(builder);
      builder.from = ((...args: Parameters<typeof from>) => {
        const selection = from(...args), execute = selection.execute.bind(selection);
        selection.execute = async () => {
          const query = selection.toSQL();
          if (query.sql.includes('"heartbeat_runs"')) queries.push(query);
          return execute();
        };
        return selection;
      }) as typeof builder.from;
      return builder;
    };
  }});
}

export async function observedSidebarFailures(db: Db, companyId: string, currentUserId?: string | null) {
  const rows = await db.select({
    id: heartbeatRuns.id, agentId: heartbeatRuns.agentId, companyId: heartbeatRuns.companyId,
    scopeKind: heartbeatRuns.scopeKind, issueId: heartbeatRuns.issueId, status: heartbeatRuns.status,
    responsibleUserId: heartbeatRuns.responsibleUserId, createdAt: heartbeatRuns.createdAt,
  }).from(heartbeatRuns).innerJoin(agents, eq(heartbeatRuns.agentId, agents.id)).where(and(
    eq(heartbeatRuns.companyId, companyId), eq(agents.companyId, companyId), not(eq(agents.status, "terminated")),
  )).orderBy(desc(heartbeatRuns.createdAt)).limit(200);
  return latestFailedRunsByAgent(rows).filter(row => currentUserId === undefined || isHeartbeatRunVisibleInMine(row, currentUserId));
}

export async function seedSidebarFixture(db: Db, mode: "mixed" | "all-failed" | "all-succeeded" | "empty" = "mixed") {
  return db.transaction(async tx => {
    const companyId = randomUUID(), foreignCompanyId = randomUUID();
    await tx.insert(companies).values([
      { id: companyId, name: "Synthetic sidebar", issuePrefix: `B${companyId.slice(0, 7)}` },
      { id: foreignCompanyId, name: "Foreign sidebar", issuePrefix: `F${foreignCompanyId.slice(0, 7)}` },
    ]);
    const actorId = randomUUID();
    await tx.insert(agents).values({ id: actorId, companyId, name: "Reader", role: "engineer" });
    const actor = { type: "agent" as const, agentId: actorId, companyId };
    const privateIssueId = randomUUID(), publicIssueId = randomUUID(), deletedIssueId = randomUUID();
    await tx.insert(issues).values([
      { id: privateIssueId, companyId, title: "Private", visibility: "private", privacyRootIssueId: privateIssueId, responsibleUserId: "other-user" },
      { id: publicIssueId, companyId, title: "Public" },
      { id: deletedIssueId, companyId, title: "Deleted" },
    ]);
    const origin = Date.parse("2026-10-01T00:00:00.000Z");
    const agentIds = Array.from({ length: mode === "all-failed" ? 240 : 30 }, () => randomUUID());
    await tx.insert(agents).values(agentIds.map((id, index) => ({ id, companyId, name: `Agent ${index}`, role: "engineer" })));
    const runs: (typeof heartbeatRuns.$inferInsert)[] = [];
    if (mode !== "empty") {
      for (let index = 0; index < 420; index++) {
        const agentIndex = index % agentIds.length;
        runs.push({ id: randomUUID(), companyId, agentId: agentIds[agentIndex]!,
          status: mode === "all-failed" ? "failed" : mode === "all-succeeded" ? "succeeded" : ["failed", "timed_out", "succeeded", "running", "queued", "cancelled"][agentIndex % 6],
          responsibleUserId: ["user-1", "user-2", null, "", "local-board"][agentIndex % 5],
          createdAt: new Date(origin + index), invocationSource: "manual" });
      }
    }
    const special: Record<string, string> = {};
    if (mode === "mixed") {
      async function add(name: string, values: Partial<typeof heartbeatRuns.$inferInsert> = {}) {
        const agentId = randomUUID(), id = randomUUID();
        await tx.insert(agents).values({ id: agentId, companyId, name, role: "engineer" });
        runs.push({ id, companyId, agentId, status: "failed", responsibleUserId: "user-1", createdAt: new Date(origin + 1000 + runs.length), ...values });
        special[name] = id;
        return agentId;
      }
      await add("outside-window", { createdAt: new Date(origin - 1000) });
      const shared = await add("superseded");
      runs.push({ companyId, agentId: shared, status: "succeeded", responsibleUserId: "user-2", createdAt: new Date(origin + 2000) });
      const foreignOwner = await add("other-user-latest");
      runs.push({ companyId, agentId: foreignOwner, status: "failed", responsibleUserId: "user-2", createdAt: new Date(origin + 2001) });
      await add("private", { scopeKind: "issue", issueId: privateIssueId });
      await add("public", { scopeKind: "issue", issueId: publicIssueId });
      await add("deleted", { scopeKind: "issue", issueId: deletedIssueId });
      await add("missing", { scopeKind: "issue", issueId: null });
      await add("dismissed");
      for (const [name, status] of [["tied-failure-first", "failed"], ["tied-success-first", "succeeded"]] as const) {
        const agentId = await add(name, { status, createdAt: new Date(origin + 3000) });
        runs.push({ companyId, agentId, status: status === "failed" ? "succeeded" : "failed", responsibleUserId: "user-1", createdAt: new Date(origin + 3000) });
      }
      const terminated = randomUUID(), crossCompanyAgent = randomUUID();
      await tx.insert(agents).values([
        { id: terminated, companyId, name: "Terminated", status: "terminated" },
        { id: crossCompanyAgent, companyId: foreignCompanyId, name: "Foreign" },
      ]);
      for (let index = 0; index < 220; index++) runs.push({ companyId, agentId: index % 2 ? terminated : crossCompanyAgent,
        status: "failed", responsibleUserId: "user-1", createdAt: new Date(origin + 10000 + index) });
      runs.push({ companyId: foreignCompanyId, agentId: crossCompanyAgent, status: "failed", createdAt: new Date(origin + 20000) });
    }
    if (runs.length) await tx.insert(heartbeatRuns).values(runs);
    if (mode === "mixed") {
      await tx.delete(issues).where(eq(issues.id, deletedIssueId));
      const microAgent = randomUUID();
      await tx.insert(agents).values({ id: microAgent, companyId, name: "Submillisecond" });
      await tx.execute(sql`insert into heartbeat_runs (company_id, agent_id, status, responsible_user_id, created_at) values
        (${companyId}, ${microAgent}, 'failed', 'user-1', '2026-10-01 00:00:04.000100+00'),
        (${companyId}, ${microAgent}, 'succeeded', 'user-2', '2026-10-01 00:00:04.000900+00')`);
    }
    const approvalId = randomUUID();
    await tx.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent", status: "pending", payload: {}, updatedAt: new Date(origin) });
    const dismissals = new Map<string, number>([[`approval:${approvalId}`, origin]]);
    const dismissed = runs.find(row => row.id === special.dismissed);
    if (dismissed) dismissals.set(`run:${dismissed.id}`, (dismissed.createdAt as Date).getTime());
    return { companyId, foreignCompanyId, actor, actorId, privateIssueId, publicIssueId, special, dismissals,
      options: { dismissals, joinRequests: [{ id: "join", createdAt: new Date(origin), updatedAt: null }], unreadTouchedIssues: 2, actor } satisfies BadgeOptions };
  });
}

export async function cleanupSidebarFixture(db: Db, fixture: Awaited<ReturnType<typeof seedSidebarFixture>>) {
  const companyIds = [fixture.companyId, fixture.foreignCompanyId];
  await db.delete(heartbeatRuns).where(inArray(heartbeatRuns.companyId, companyIds));
  await db.delete(approvals).where(inArray(approvals.companyId, companyIds));
  await db.delete(issues).where(inArray(issues.companyId, companyIds));
  await db.delete(agents).where(inArray(agents.companyId, companyIds));
  await db.delete(companies).where(inArray(companies.id, companyIds));
}
