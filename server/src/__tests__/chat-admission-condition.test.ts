import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { agentWakeupRequests, agents, chatActions, chatConversations, createDb, issues, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedGitHubReviewWait } from "./helpers/github-review-wait.js";
import { unadmittedChatWakeupCondition } from "../services/durable-chat-wakeup.js";

// Pins which saved chat input holds an issue as "not admitted". Recovery skips
// held issues and manual task start refuses them.
describe("unadmitted chat wakeup condition", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    if (process.env.PAPERCLIP_TEST_DATABASE_URL) {
      db = createDb(process.env.PAPERCLIP_TEST_DATABASE_URL);
    } else {
      temporary = await startEmbeddedPostgresTestDatabase("chat-admission-condition-");
      db = createDb(temporary.connectionString);
    }
  }, 120_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function seed() {
    const f = await seedGitHubReviewWait(db);
    const otherConversationId = randomUUID();
    await db.insert(chatConversations).values({ id: otherConversationId, companyId: f.companyId,
      endpointId: f.endpointId, resourceId: f.resourceId, issueId: f.issueId, externalConversationId: "other",
      externalThreadId: `other:${otherConversationId}`, externalLabel: "Other" });
    let tick = 0;
    const action = async (input: { status: string; kind?: string; issueId?: unknown; agentId?: string;
      conversationId?: string; companyId?: string; endpointId?: string; payload?: Record<string, unknown> }) => {
      const id = randomUUID();
      await db.insert(chatActions).values({ id, companyId: input.companyId ?? f.companyId,
        endpointId: input.endpointId ?? f.endpointId, conversationId: input.conversationId ?? f.conversationId,
        kind: input.kind ?? "inbound_wakeup", providerActionId: id, status: input.status,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
        payload: { issueId: "issueId" in input ? input.issueId : f.issueId, agentId: input.agentId ?? f.agentId,
          sessionGeneration: 1, ...input.payload } });
      return id;
    };
    const admit = (id: string, status = "queued", agentId = f.agentId, companyId = f.companyId) =>
      db.insert(agentWakeupRequests).values({ id, companyId, agentId, source: "automation", status });
    const held = async () => (await db.select({ id: issues.id }).from(issues).where(and(
      eq(issues.id, f.issueId), eq(issues.companyId, f.companyId),
      unadmittedChatWakeupCondition(issues.id, issues.companyId))).limit(1)).length === 1;
    const reset = async () => {
      await db.delete(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, f.companyId));
      await db.delete(chatActions).where(eq(chatActions.companyId, f.companyId));
    };
    return { ...f, otherConversationId, action, admit, held, reset };
  }

  it("holds only pending or failed inbound input without an admission receipt", async () => {
    const s = await seed();
    expect(await s.held()).toBe(false);
    for (const status of ["preparing", "issued", "processing", "failed"]) {
      await s.reset();
      await s.action({ status });
      expect(await s.held(), status).toBe(true);
    }
    for (const status of ["received", "processed", "cancelled"]) {
      await s.reset();
      await s.action({ status });
      expect(await s.held(), status).toBe(false);
    }
    // Another kind with the same issue id never holds.
    await s.reset();
    await s.action({ status: "preparing", kind: "failed_run_retry" });
    await s.action({ status: "processing", kind: "interaction_wakeup" });
    expect(await s.held()).toBe(false);
  });

  it("accepts only a receipt for the same company and agent that was not skipped", async () => {
    const s = await seed();
    const otherAgentId = randomUUID();
    await db.insert(agents).values({ id: otherAgentId, companyId: s.companyId, name: "Other", adapterType: "process" });
    const pending = await s.action({ status: "processing" });
    await s.admit(pending, "skipped");
    expect(await s.held()).toBe(true);
    await db.update(agentWakeupRequests).set({ status: "failed" }).where(eq(agentWakeupRequests.id, pending));
    // A failed or cancelled run is still historical admission.
    expect(await s.held()).toBe(false);
    await db.update(agentWakeupRequests).set({ agentId: otherAgentId }).where(eq(agentWakeupRequests.id, pending));
    expect(await s.held()).toBe(true);

    const other = await seedGitHubReviewWait(db);
    await s.reset();
    const crossCompany = await s.action({ status: "processing" });
    await s.admit(crossCompany, "queued", other.agentId, other.companyId);
    expect(await s.held()).toBe(true);
  });

  it("compares the issue id as company-scoped canonical text", async () => {
    const s = await seed();
    const other = await seedGitHubReviewWait(db);
    await s.action({ status: "preparing", companyId: other.companyId, endpointId: other.endpointId,
      conversationId: other.conversationId });
    await s.action({ status: "preparing", issueId: s.issueId.toUpperCase() });
    await s.action({ status: "preparing", issueId: [s.issueId] });
    await s.action({ status: "preparing", issueId: null });
    await s.action({ status: "preparing", issueId: randomUUID() });
    expect(await s.held()).toBe(false);
    await s.action({ status: "preparing" });
    expect(await s.held()).toBe(true);
  });

  it("releases skipped input only through an admitted retry of the same conversation and issue", async () => {
    const s = await seed();
    const skipped = await s.action({ status: "issued" });
    const retry = (input: Partial<Parameters<typeof s.action>[0]> = {}) => s.action({ status: "processed",
      kind: "failed_run_retry", ...input, payload: { taskRetryInput: { skippedActionIds: [skipped] }, ...input.payload } });
    // Not admitted, skipped, other conversation, other issue, or not listing the action.
    await retry();
    await s.admit(await retry(), "skipped");
    await s.admit(await retry({ conversationId: s.otherConversationId }));
    await s.admit(await retry({ issueId: randomUUID() }));
    await s.admit(await retry({ payload: { taskRetryInput: { skippedActionIds: [randomUUID()] } } }));
    expect(await s.held()).toBe(true);
    await s.admit(await retry());
    expect(await s.held()).toBe(false);
  });

  it("releases a failed input only through later admitted input of the same session generation", async () => {
    const s = await seed();
    const failed = await s.action({ status: "failed" });
    const pending = await s.action({ status: "preparing" });
    void pending;
    // Later input from another generation or conversation does not settle it.
    await s.admit(await s.action({ status: "processed", payload: { sessionGeneration: 2 } }));
    await s.admit(await s.action({ status: "processed", conversationId: s.otherConversationId }));
    await s.admit(await s.action({ status: "processed" }), "skipped");
    await db.delete(chatActions).where(eq(chatActions.id, pending));
    expect(await s.held()).toBe(true);
    await s.admit(await s.action({ status: "processed" }));
    expect(await s.held()).toBe(false);

    // Earlier admitted input does not settle a later failure; nor does any later
    // input settle input that is still pending.
    await s.reset();
    await s.admit(await s.action({ status: "processed" }));
    await s.action({ status: "failed" });
    expect(await s.held()).toBe(true);
    await s.reset();
    await s.action({ status: "processing" });
    await s.admit(await s.action({ status: "processed" }));
    expect(await s.held()).toBe(true);
    void failed;
  });

  it("finds the issue's chat input through the company and issue index", async () => {
    const s = await seed();
    await db.$client.unsafe(`insert into chat_actions (company_id, endpoint_id, kind, provider_action_id, status, payload)
      select $1::uuid, $2::uuid, case when g % 3 = 0 then 'github_review_check' else 'inbound_wakeup' end,
        'noise-' || g, 'processed', jsonb_build_object('issueId', gen_random_uuid()::text, 'body', repeat('x', 200))
      from generate_series(1, 3000) g`, [s.companyId, s.endpointId]);
    await db.$client.unsafe("analyze chat_actions");
    await s.action({ status: "failed" });
    const query = db.select({ id: issues.id }).from(issues).where(and(eq(issues.id, s.issueId),
      eq(issues.companyId, s.companyId), unadmittedChatWakeupCondition(issues.id, issues.companyId))).limit(1).toSQL();
    const [row] = await db.$client.unsafe(`EXPLAIN (FORMAT JSON) ${query.sql}`, query.params as never[]);
    const scans: string[] = [];
    const walk = (node: Record<string, unknown>) => {
      if (node["Relation Name"] === "chat_actions") scans.push(`${node["Node Type"]}:${node["Index Name"] ?? ""}`);
      for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
    };
    walk((row!["QUERY PLAN"] as Array<{ Plan: Record<string, unknown> }>)[0]!.Plan);
    expect(scans.length).toBeGreaterThan(0);
    for (const scan of scans) expect(scan).toMatch(/Index.*Scan:chat_actions_company_issue_kind_idx/);
  });
});
