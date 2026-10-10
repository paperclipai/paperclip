import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueRecoveryActions, issues } from "@paperclipai/db";
import { deliverExecutionStatuses } from "../services/execution-status-delivery.js";
import { conversationRecoveryActionPredicate } from "../services/conversation-continuation.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("execution UUID joins", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const statements: { query: string; params: unknown[] }[] = [];
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("execution-uuid-");
    const connection = createDb(temporary.connectionString);
    db = drizzle(connection.$client, { schema: connection._.fullSchema, logger: {
      logQuery(query, params) { statements.push({ query, params }); },
    } }) as typeof db;
  }, 30_000);
  afterAll(async () => { await temporary?.cleanup(); });

  it("preserves canonical IDs, native precedence, and company isolation without cast errors", async () => {
    const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID();
    const issueId = "abcdefab-1234-4567-89ab-abcdefabcdef", nativeId = randomUUID(), foreignId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "UUID joins", issuePrefix: "UUID" },
      { id: otherCompanyId, name: "Other", issuePrefix: "OTHER" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "process" });
    await db.insert(issues).values([
      { id: issueId, companyId, title: "Legacy" }, { id: nativeId, companyId, title: "Native" },
      { id: foreignId, companyId: otherCompanyId, title: "Foreign" },
    ]);
    const cases = [
      { context: issueId, expected: issueId },
      { context: issueId.toUpperCase(), expected: null },
      { context: issueId.replaceAll("-", ""), expected: null },
      { context: `{${issueId}}`, expected: null },
      { context: "------------------------------------", expected: null },
      { context: "not-a-uuid", expected: null },
      { context: `${issueId}\n`, expected: null },
      { context: null, expected: null }, { context: 42, expected: null },
      { context: { id: issueId }, expected: null }, { context: [issueId], expected: null },
      { context: foreignId, expected: null }, { context: randomUUID(), expected: null },
      { context: "not-a-uuid", native: nativeId, expected: nativeId },
      { context: issueId, native: foreignId, expected: null },
      { context: issueId, native: randomUUID(), expected: null },
    ];
    const runs = cases.map(c => ({ id: randomUUID(), companyId, agentId, status: "failed",
      nativeIssueId: c.native, contextSnapshot: { issueId: c.context }, executionStatusDeliveryId: randomUUID() }));
    await db.insert(heartbeatRuns).values(runs);
    const delivered = new Map<string, unknown>();
    expect(await deliverExecutionStatuses(db, { publish: event => {
      delivered.set(event.payload.runId as string, event.payload.issueId);
    } })).toEqual({ scanned: cases.length, delivered: cases.length });
    cases.forEach((c, i) => expect(delivered.get(runs[i]!.id)).toBe(c.expected));
    expect(await deliverExecutionStatuses(db, { publish: () => { throw new Error("Already delivered"); } }))
      .toEqual({ scanned: 0, delivered: 0 });
  });

  it("rejects noncanonical and cross-company recovery references", async () => {
    const companyId = randomUUID(), otherCompanyId = randomUUID(), agentId = randomUUID();
    const runId = "abcdefab-1234-4567-89ab-abcdefabcdee";
    await db.insert(companies).values([
      { id: companyId, name: "Recovery UUID", issuePrefix: "REC" },
      { id: otherCompanyId, name: "Other recovery", issuePrefix: "OREC" },
    ]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "process" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Recovery" }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "interrupted",
      contextSnapshot: { issueId: issue!.id }, resultJson: { conversationContinuation: "continue_conversation_v1" } });
    const references = [runId, runId.toUpperCase(), runId.replaceAll("-", ""), `{${runId}}`,
      "------------------------------------", "not-a-uuid", null, 42, { id: runId }, [runId]];
    const actions = [];
    for (const reference of references) {
      const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue!.id,
        kind: "active_run_watchdog", status: "resolved", cause: "legacy_execution_requires_reconciliation",
        fingerprint: randomUUID(), nextAction: "Inspect", evidence: { runId: reference } }).returning();
      actions.push(action!);
    }
    // Source IDs remain company-scoped even when evidence names a real run.
    const [foreign] = await db.insert(issueRecoveryActions).values({ companyId: otherCompanyId,
      sourceIssueId: issue!.id, kind: "active_run_watchdog", status: "resolved",
      cause: "legacy_execution_requires_reconciliation", fingerprint: randomUUID(), nextAction: "Inspect",
      evidence: { runId } }).returning();
    const matched = await db.select({ id: issueRecoveryActions.id }).from(issueRecoveryActions)
      .where(conversationRecoveryActionPredicate());
    expect(matched).toEqual([{ id: actions[0]!.id }]);
    expect(matched.some(row => row.id === foreign!.id)).toBe(false);
    await db.update(issueRecoveryActions).set({ status: "active" }).where(eq(issueRecoveryActions.id, actions[5]!.id));
    // Exercise the settlement query too: malformed evidence must leave its hold intact.
    await settleUnrecoverableExecutions(db);
    expect(await db.select({ status: issueRecoveryActions.status }).from(issueRecoveryActions)
      .where(eq(issueRecoveryActions.id, actions[5]!.id))).toEqual([{ status: "active" }]);
  });

  it("settles a canonical failed run and preserves the no-replay recovery contract", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Settlement", issuePrefix: "SET" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "process" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Failed work",
      status: "in_progress", assigneeAgentId: agentId }).returning();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "failed",
      contextSnapshot: { issueId: issue!.id } });
    const [action] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue!.id,
      returnOwnerAgentId: agentId, kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      fingerprint: randomUUID(), nextAction: "Inspect", evidence: { runId } }).returning();
    await settleUnrecoverableExecutions(db);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id, action!.id)))
      .toMatchObject([{ status: "resolved", outcome: "blocked", evidence: {
        runId, automaticRecovery: { runId, replay: "blocked", actionOutcome: "unknown" },
      } }]);
    expect(await db.select().from(issues).where(eq(issues.id, issue!.id)))
      .toMatchObject([{ status: "blocked", executionRunId: null, checkoutRunId: null }]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run!.status).toBe("failed");
    expect(run!.executionStatusDeliveryId).not.toBeNull();
    await deliverExecutionStatuses(db, { publish: () => {} });
  });

  it("allows UUID index conditions in the actual delivery and recovery queries", async () => {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Index plans", issuePrefix: "PLAN" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "process" });
    const [issue] = await db.insert(issues).values({ companyId, title: "Plan" }).returning();
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "failed" });
    await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issue!.id,
      kind: "active_run_watchdog", cause: "legacy_execution_requires_reconciliation",
      fingerprint: randomUUID(), nextAction: "Inspect", evidence: { runId: "invalid" } });
    // Enough same-company terminal runs that a company/status scan is more
    // expensive than the unique run lookup; ANALYZE avoids stale estimates.
    await db.$client`insert into heartbeat_runs (company_id, agent_id, status)
      select ${companyId}, ${agentId}, 'failed' from generate_series(1, 2000)`;
    await db.$client`insert into issues (company_id, title)
      select ${companyId}, 'Plan filler' from generate_series(1, 2000)`;
    await db.$client`analyze heartbeat_runs`;
    await db.$client`analyze issues`;
    await db.$client`analyze issue_recovery_actions`;
    statements.length = 0;
    await deliverExecutionStatuses(db, { publish: () => {} });
    await settleUnrecoverableExecutions(db);
    const selects = statements.filter(s =>
      s.query.includes('left join "issues"') || s.query.includes('inner join "heartbeat_runs"'));
    expect(selects).toHaveLength(2);
    // Force nested-loop alternatives to check index eligibility, independent of
    // fixture size. The benchmark separately measures the planner's default choice.
    await db.$client.begin(async tx => {
      await tx`set local enable_seqscan = off`;
      await tx`set local enable_hashjoin = off`;
      await tx`set local enable_mergejoin = off`;
      for (const statement of selects) {
        const rows = await tx.unsafe(`explain (format json) ${statement.query}`, statement.params as never[]);
        type Plan = { "Relation Name"?: string; "Alias"?: string; "Index Name"?: string;
          "Index Cond"?: string; Plans?: Plan[] };
        const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
        const relation = statement.query.includes('left join "issues"') ? "issues" : "heartbeat_runs";
        const lookups = nodes(rows[0]!["QUERY PLAN"][0].Plan as Plan).filter(node =>
          node["Relation Name"] === relation && node.Alias === relation && typeof node["Index Name"] === "string");
        expect(lookups.some(node => /\bid = /.test(node["Index Cond"] ?? "")), JSON.stringify(rows[0]!["QUERY PLAN"])).toBe(true);
      }
    });
  });
});
