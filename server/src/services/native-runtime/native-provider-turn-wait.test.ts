import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRuns, issueComments, issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { notifyDeferredExecutionWork } from "../deferred-execution-notifications.js";
import {
  awaitPersonCommentDuringNativeRun, nativeProviderTurnWaitOptions, nativeProviderTurnWaitStartedAt, personCommentedDuringNativeRun,
} from "./native-provider-turn-wait.js";

const support = await getEmbeddedPostgresTestSupport();
const USER = "provider-turn-user";

describe.skipIf(!support.supported)("native provider-turn wait control-plane hooks", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-provider-turn-wait-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed(startedAt = new Date()) {
    const [company] = await db.insert(companies).values({ name: "Provider turn", issuePrefix: `P${randomUUID().slice(0, 4)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Claude", adapterType: "paperclip_runner" }).returning();
    const issueId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "running", runtimeMode: "native",
      runtimeModeResolvedAt: new Date(), nativeIssueId: issueId, responsibleUserId: USER, startedAt, contextSnapshot: { issueId } }).returning();
    await db.insert(issues).values({ id: issueId, companyId: company!.id, title: "Install and test", status: "in_progress",
      assigneeAgentId: agent!.id, executionRunId: run!.id });
    return { companyId: company!.id, agentId: agent!.id, issueId, runId: run!.id };
  }

  async function comment(f: Awaited<ReturnType<typeof seed>>, author: "user" | "agent", queued: boolean, createdAt?: Date) {
    const [saved] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: f.issueId,
      ...(author === "user" ? { authorType: "user", authorUserId: USER } : { authorType: "agent", authorAgentId: f.agentId }),
      body: "The install finished, please continue.", ...(createdAt ? { createdAt } : {}) }).returning();
    if (queued) {
      await db.transaction(async tx => {
        await notifyDeferredExecutionWork(tx, { companyId: f.companyId });
        await tx.insert(agentWakeupRequests).values({ companyId: f.companyId, agentId: f.agentId, source: "automation",
          triggerDetail: "system", reason: "issue_commented", status: "deferred_issue_execution",
          requestedByActorType: "user", requestedByActorId: USER,
          payload: { issueId: f.issueId, commentId: saved!.id, _paperclipWakeContext: { issueId: f.issueId, taskId: f.issueId,
            wakeReason: "issue_commented", source: "issue.comment", wakeCommentId: saved!.id, wakeCommentIds: [saved!.id] } } });
      });
    }
    return saved!.id;
  }

  const prpTerminal = (f: Awaited<ReturnType<typeof seed>>, awaiting: boolean) => appendHeartbeatRunEvent(db, {
    companyId: f.companyId, runId: f.runId, agentId: f.agentId, eventType: "turn.completed", stream: "system", level: "info",
    message: "turn completed", payload: { prpEvent: { eventType: "turn.completed", turnId: "turn-1",
      payload: { status: "completed", error: null, ...(awaiting ? { awaitingProviderTurn: true } : {}) } } } });

  it("restores the wait clock from the first awaited terminal and has none for a previous release's run", async () => {
    const f = await seed();
    await prpTerminal(f, false);
    expect(await nativeProviderTurnWaitStartedAt(db, f)).toBeNull();
    await prpTerminal(f, true);
    const first = await nativeProviderTurnWaitStartedAt(db, f);
    expect(first).toEqual(expect.any(Number));
    await new Promise(resolve => setTimeout(resolve, 20));
    await prpTerminal(f, true);
    expect(await nativeProviderTurnWaitStartedAt(db, f)).toBe(first);
    expect((await nativeProviderTurnWaitOptions(db, f)).startedAtMs).toBe(first);
  });

  it("counts only a person's queued comment made during this run", async () => {
    const f = await seed(new Date(Date.now() - 60_000));
    await comment(f, "user", true, new Date(Date.now() - 120_000));
    await comment(f, "agent", true);
    await comment(f, "user", false);
    expect(await personCommentedDuringNativeRun(db, f)).toBe(false);
    await comment(f, "user", true);
    expect(await personCommentedDuringNativeRun(db, f)).toBe(true);
  });

  it("ends the wait when a person's comment is queued, through the deferred-wake notification", async () => {
    const f = await seed();
    const abort = new AbortController();
    let ended = false;
    const waiting = awaitPersonCommentDuringNativeRun(db, f, abort.signal).then(() => { ended = true; });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(ended).toBe(false);
    await comment(f, "user", true);
    await waiting;
    expect(ended).toBe(true);
  });

  it("stops listening when the wait ends for another reason", async () => {
    const f = await seed();
    const abort = new AbortController();
    const waiting = awaitPersonCommentDuringNativeRun(db, f, abort.signal);
    abort.abort(new Error("wait ended"));
    await expect(waiting).rejects.toThrow("wait ended");
  });
});
