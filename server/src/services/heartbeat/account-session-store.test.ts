import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, agentTaskSessions, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { accountSessionStore } from "./account-session-store.js";
import { createHeartbeatRunState } from "./run-state.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skipping account session store tests: ${support.reason}`);

describePostgres("account session store", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string, otherCompanyId: string, sessionId: string;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("account-session-store-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID(); otherCompanyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values([{ id: companyId, name: "Session company", issuePrefix: `A${companyId.slice(0, 6)}` }, { id: otherCompanyId, name: "Other company", issuePrefix: `B${otherCompanyId.slice(0, 6)}` }]);
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", adapterType: "test", status: "idle" });
    [ { id: sessionId } ] = await db.insert(agentTaskSessions).values({ companyId, agentId, adapterType: "test", taskKey: "task", goalJson: { goal: "preserved" } }).returning();
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  it("isolates identities, upserts state, enforces company scope and cascades with the parent", async () => {
    const store = accountSessionStore(db);
    const first = { companyId, sessionId, sessionIdentity: "identity:epoch1" };
    const second = { ...first, sessionIdentity: "identity:epoch2" };
    await store.upsert(first, { sessionParamsJson: { sessionId: "one" }, sessionDisplayId: "one", lastRunId: null, lastError: null });
    await store.upsert(second, { sessionParamsJson: { sessionId: "two" }, sessionDisplayId: "two", lastRunId: null, lastError: "error" });
    await store.upsert(first, { sessionParamsJson: { sessionId: "updated" }, sessionDisplayId: "updated", lastRunId: null, lastError: null });
    expect(await store.get(first)).toMatchObject({ sessionDisplayId: "updated", sessionParamsJson: { sessionId: "updated" } });
    expect(await store.get(second)).toMatchObject({ sessionDisplayId: "two", lastError: "error" });
    await Promise.all(["concurrent-a", "concurrent-b"].map((value) => store.upsert(first, {
      sessionParamsJson: { value }, sessionDisplayId: value, lastRunId: null, lastError: null,
    })));
    expect(["concurrent-a", "concurrent-b"]).toContain((await store.get(first))?.sessionDisplayId);
    expect(await store.get({ ...first, companyId: otherCompanyId })).toBeUndefined();
    await expect(store.upsert({ ...first, companyId: otherCompanyId }, { sessionParamsJson: null, sessionDisplayId: "wrong", lastRunId: null, lastError: null })).rejects.toThrow();
    expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, sessionId)))[0]?.goalJson).toEqual({ goal: "preserved" });
    await db.delete(agentTaskSessions).where(eq(agentTaskSessions.id, sessionId));
    expect(await store.get(first)).toBeUndefined();
    expect(await store.get(second)).toBeUndefined();
  });

  it("persists managed session state with the parent while leaving unmanaged sessions alone", async () => {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Managed agent", adapterType: "test", status: "idle" });
    const runState = createHeartbeatRunState(db);
    const base = { companyId, agentId, adapterType: "test", taskKey: "managed", lastRunId: null, lastError: null };
    const first = await runState.upsertTaskSession({ ...base, sessionDisplayId: "one", sessionParamsJson: { paperclipAiCredentialIdentity: "opaque:1", sessionId: "one" } });
    await runState.upsertTaskSession({ ...base, sessionDisplayId: "two", sessionParamsJson: { paperclipAiCredentialIdentity: "opaque:2", sessionId: "two" } });
    const store = accountSessionStore(db);
    expect(await store.get({ companyId, sessionId: first!.id, sessionIdentity: "opaque:1" })).toMatchObject({ sessionDisplayId: "one" });
    expect(await store.get({ companyId, sessionId: first!.id, sessionIdentity: "opaque:2" })).toMatchObject({ sessionDisplayId: "two" });
    const unmanaged = await runState.upsertTaskSession({ ...base, taskKey: "unmanaged", sessionDisplayId: "legacy", sessionParamsJson: { sessionId: "legacy" } });
    expect(await store.get({ companyId, sessionId: unmanaged!.id, sessionIdentity: "opaque:1" })).toBeUndefined();
  });

  it("clears only the selected account while preserving other accounts and the goal", async () => {
    const agentId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Clear agent", adapterType: "test", status: "idle" });
    const state = createHeartbeatRunState(db);
    const base = { companyId, agentId, adapterType: "test", taskKey: "clear", lastRunId: null, lastError: null };
    const parent = await state.upsertTaskSession({ ...base, sessionDisplayId: "a", sessionParamsJson: { paperclipAiCredentialIdentity: "a" } });
    await state.upsertTaskSession({ ...base, sessionDisplayId: "b", sessionParamsJson: { paperclipAiCredentialIdentity: "b" } });
    await db.update(agentTaskSessions).set({ goalJson: { goal: "keep" }, goalStatus: "active" }).where(eq(agentTaskSessions.id, parent!.id));
    await state.clearTaskSessions(companyId, agentId, { taskKey: "clear", adapterType: "test", sessionIdentity: "a" });
    const store = accountSessionStore(db);
    expect(await store.get({ companyId, sessionId: parent!.id, sessionIdentity: "a" })).toBeUndefined();
    expect(await store.get({ companyId, sessionId: parent!.id, sessionIdentity: "b" })).toMatchObject({ sessionDisplayId: "b" });
    expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, parent!.id)))[0]).toMatchObject({ goalJson: { goal: "keep" }, goalStatus: "active", sessionDisplayId: "b" });
    await state.clearTaskSessions(companyId, agentId, { taskKey: "clear", adapterType: "test", sessionIdentity: "b" });
    expect((await db.select().from(agentTaskSessions).where(eq(agentTaskSessions.id, parent!.id)))[0]).toMatchObject({ goalJson: { goal: "keep" }, sessionDisplayId: null, sessionParamsJson: null });
  });

  it("does not clear an account for a cancelled conversation run", async () => {
    const agentId = randomUUID(), issueId = randomUUID();
    await db.insert(agents).values({ id: agentId, companyId, name: "Conversation agent", adapterType: "test", status: "idle" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Conversation", issueNumber: 1, assigneeAgentId: agentId });
    await db.update(issues).set({ conversationAgentId: agentId, conversationUserId: "test-user", conversationState: "active", conversationSessionGeneration: 1 }).where(eq(issues.id, issueId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "assignment", status: "succeeded", contextSnapshot: { conversationSessionGeneration: 1 } }).returning();
    const state = createHeartbeatRunState(db);
    const parent = await state.upsertTaskSession({ companyId, agentId, adapterType: "test", taskKey: issueId, sessionDisplayId: "a", sessionParamsJson: { paperclipAiCredentialIdentity: "a" }, lastRunId: run.id, lastError: null });
    await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, run.id));
    expect(await state.clearTaskSessions(companyId, agentId, { taskKey: issueId, expectedRunId: run.id, sessionIdentity: "a" })).toBe(0);
    expect(await accountSessionStore(db).get({ companyId, sessionId: parent!.id, sessionIdentity: "a" })).toMatchObject({ sessionDisplayId: "a" });
  });
});

