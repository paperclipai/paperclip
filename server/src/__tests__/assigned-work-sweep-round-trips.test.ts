import { randomUUID } from "node:crypto";
import { sql as sqlTag } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, issueTreeHolds } from "@paperclipai/db";
import { assignedWorkSweep } from "../services/recovery/assigned-work-sweep.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const gate = vi.hoisted(() => ({ perIssueCalls: 0 }));
vi.mock("../services/issue-tree-control.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../services/issue-tree-control.js")>();
  return {
    ...actual,
    issueTreeControlService: (db: Parameters<typeof actual.issueTreeControlService>[0]) => {
      const service = actual.issueTreeControlService(db);
      return { ...service, getActivePauseHoldGate: async (...args: Parameters<typeof service.getActivePauseHoldGate>) => {
        gate.perIssueCalls += 1;
        return service.getActivePauseHoldGate(...args);
      } };
    },
  };
});

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping assigned-work round-trip tests: ${recoveryPostgresSupport.reason}`);

const HOUR = 60 * 60_000;

describePostgres("assigned-work sweep database round trips", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  let statements = 0;

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("assigned-work-round-trips-");
    db = createDb(temporary.connectionString);
    (db.$client as unknown as { options: { debug?: unknown } }).options.debug = () => { statements += 1; };
  }, 240_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  it("reads pause holds and assignees once per batch on 1,500 open tasks with hundreds of holds and wakes", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Round trips", issuePrefix: `R${companyId.slice(0, 7)}` });
    const agentIds = Array.from({ length: 20 }, () => randomUUID());
    await db.insert(agents).values(agentIds.map((id, index) => ({ id, companyId, name: `Agent ${index}`, adapterType: "codex_local",
      status: "idle", adapterConfig: {} })));
    const rows: Array<typeof issues.$inferInsert> = [];
    const roots: string[] = [];
    for (let index = 0; index < 1_500; index += 1) {
      const id = randomUUID();
      const isRoot = index < 300;
      const isChild = index >= 300 && index < 600;
      if (isRoot) roots.push(id);
      rows.push({ id, companyId, title: `Task ${index}`, status: index % 5 === 0 ? "todo" : "in_progress",
        assigneeAgentId: agentIds[index % agentIds.length], issueNumber: index + 1, identifier: `R${companyId.slice(0, 5)}-${index + 1}`,
        parentId: isChild ? roots[index - 300] : null, updatedAt: new Date(Date.now() - (index + 1) * 60_000),
        createdAt: new Date(Date.now() - 5 * HOUR) });
    }
    for (let index = 0; index < rows.length; index += 250) await db.insert(issues).values(rows.slice(index, index + 250));
    await db.insert(issueTreeHolds).values(roots.map(rootIssueId => ({ companyId, rootIssueId, mode: "pause", status: "active",
      reason: "fixture" })));
    const runs = rows.map((row, index) => ({ companyId, agentId: row.assigneeAgentId!, invocationSource: "automation",
      status: "succeeded", startedAt: new Date(Date.now() - 4 * HOUR - index), finishedAt: new Date(Date.now() - 3 * HOUR - index),
      createdAt: new Date(Date.now() - 4 * HOUR - index), contextSnapshot: { issueId: row.id, taskId: row.id } }));
    for (let index = 0; index < runs.length; index += 500) await db.insert(heartbeatRuns).values(runs.slice(index, index + 500));
    await db.insert(agentWakeupRequests).values(rows.slice(600, 1_000).map(row => ({ companyId, agentId: row.assigneeAgentId!,
      source: "automation", triggerDetail: "system", reason: "issue_assigned", status: "queued", payload: { issueId: row.id } })));
    await db.execute(sqlTag`analyze`);

    const enqueueWakeup = vi.fn(async () => null);
    const sweep = assignedWorkSweep(db, { enqueueWakeup });
    const measure = async <T>(work: () => Promise<T>) => {
      gate.perIssueCalls = 0; statements = 0;
      const started = performance.now();
      const value = await work();
      return { value, ms: Math.round(performance.now() - started), gateCalls: gate.perIssueCalls, statements };
    };

    const report = await measure(() => sweep.report(companyId));

    const pass = await measure(async () => {
      const suspects = await sweep.listSuspects({ companyId }, null, 100);
      const verdicts: Record<string, number> = {};
      for (const suspect of suspects) {
        const check = await sweep.checkIssue({ companyId, issueId: suspect.id });
        const key = check?.verdict.kind === "ok" && check.verdict.clause === "waiting" ? check.verdict.reason : check?.verdict.kind ?? "none";
        verdicts[key] = (verdicts[key] ?? 0) + 1;
      }
      return { suspects: suspects.length, verdicts };
    });
    const heldChild = rows[300]!.id!;
    const held = await measure(() => sweep.checkIssue({ companyId, issueId: heldChild }));
    expect(held.value).toMatchObject({ outcome: "ok", verdict: { clause: "waiting", reason: "agent_paused" } });

    console.info(JSON.stringify({ assignedWorkRoundTrips: {
      report: { ms: report.ms, statements: report.statements, perIssueGateCalls: report.gateCalls },
      sweepPass: { ms: pass.ms, statements: pass.statements, perIssueGateCalls: pass.gateCalls, ...pass.value },
      oneHeldCheck: { ms: held.ms, statements: held.statements, perIssueGateCalls: held.gateCalls },
    } }));
    expect(report.value).toMatchObject({ checked: 1_500, violationCount: 500 });
    expect(report.value.ok).toEqual({ "waiting:agent_paused": 300, "waiting:dependency": 300, "pending:queued_wake": 400 });
    expect(report.gateCalls).toBe(0);
    expect(pass.gateCalls).toBe(0);
    expect(held.gateCalls).toBe(0);
    expect(report.statements).toBeLessThan(8 * 40);
  }, 300_000);

  it("the batched pause read gives the per-issue gate's answer: deep chains, cycles, released holds, other companies", async () => {
    const { issueTreeControlService } = await import("../services/issue-tree-control.js");
    const companyId = randomUUID(), otherCompanyId = randomUUID();
    await db.insert(companies).values([{ id: companyId, name: "Gate", issuePrefix: `G${companyId.slice(0, 7)}` },
      { id: otherCompanyId, name: "Other", issuePrefix: `O${otherCompanyId.slice(0, 7)}` }]);
    let number = 0;
    const issue = async (values: Partial<typeof issues.$inferInsert> = {}) => {
      const id = randomUUID(); number += 1;
      await db.insert(issues).values({ id, companyId, title: `Gate ${number}`, status: "todo", issueNumber: number, ...values });
      return id;
    };
    const root = await issue();
    const child = await issue({ parentId: root });
    const grandchild = await issue({ parentId: child });
    const releasedRoot = await issue();
    const underReleased = await issue({ parentId: releasedRoot });
    const loopA = await issue();
    const loopB = await issue({ parentId: loopA });
    await db.update(issues).set({ parentId: loopB }).where(sqlTag`${issues.id} = ${loopA}`);
    const lone = await issue();
    const otherRoot = randomUUID();
    await db.insert(issues).values({ id: otherRoot, companyId: otherCompanyId, title: "Other root", status: "todo", issueNumber: 1 });
    await db.insert(issueTreeHolds).values([
      { companyId, rootIssueId: root, mode: "pause", status: "active" },
      { companyId, rootIssueId: releasedRoot, mode: "pause", status: "released" },
      { companyId: otherCompanyId, rootIssueId: otherRoot, mode: "pause", status: "active" },
    ]);
    const service = issueTreeControlService(db);
    const ids = [root, child, grandchild, releasedRoot, underReleased, loopA, loopB, lone, otherRoot];
    const batched = await service.listActivePauseHeldIssueIds(companyId, ids);
    const perIssue = new Set<string>();
    for (const id of ids) if (await service.getActivePauseHoldGate(companyId, id)) perIssue.add(id);
    expect([...batched].sort()).toEqual([...perIssue].sort());
    expect([...batched].sort()).toEqual([root, child, grandchild].sort());
  }, 60_000);
});
