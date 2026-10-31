import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { createDatabaseResponseCapture, installDatabaseResponseCapture } from "@paperclipai/db/response-capture";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { readChatAuthorizationRun } from "./authorization-run-read.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("chat authorization run reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("chat-authorization-read-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Chat authorization fixture", issuePrefix: "CAR" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Chat agent", adapterType: "process" }).returning();
    companyId = company.id;
    agentId = agent.id;
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function seed(contextSnapshot: unknown = {}) {
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId, contextSnapshot: contextSnapshot as Record<string, unknown> | null,
    }).returning();
    return { companyId, agentId, failedRunId: run.id };
  }

  it("reads committed authority below the byte budget and keeps complete retry evidence", async () => {
    const bulk = randomBytes(128 * 1024).toString("base64");
    const context = {
      source: "chat:slack", issueId: randomUUID(), interactionId: null, taskKey: "CAR-1",
      wakeCommentIds: [randomUUID()], wakeCommentId: null,
      chatFailedRunRetry: { version: 1, actionId: randomUUID(), failedRunId: randomUUID() },
      retryOfRunId: randomUUID(),
    };
    const scope = await seed({ ...context, savedInput: bulk });
    await db.update(heartbeatRuns).set({ runnerProfileJson: { savedInput: bulk }, stdoutExcerpt: bulk, stderrExcerpt: bulk })
      .where(eq(heartbeatRuns.id, scope.failedRunId));
    const [before] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.failedRunId));
    const events: Array<Record<string, unknown>> = [];
    const now = Date.now();
    const capture = createDatabaseResponseCapture({ start: now - 100, end: now + 59_000 }, event => events.push(event));
    installDatabaseResponseCapture(db, { heartbeatRuns }, capture);
    try {
      const selected = await db.transaction(tx => readChatAuthorizationRun(tx, scope, true));
      expect(selected.kind).toBe("committed");
      expect(selected.run?.contextSnapshot).toEqual(context);
      expect(selected.run).not.toHaveProperty("runnerProfileJson");
      expect(selected.run).not.toHaveProperty("stdoutExcerpt");
    } finally { capture.flush(); }
    const summary = events.find(event => event.event === "paperclip.db_response_capture.summary.v1")!;
    expect(summary.completedQueries).toBeGreaterThan(0);
    expect(summary.responseValueBytes).toBeLessThan(4096);
    const retry = await db.transaction(tx => readChatAuthorizationRun(tx, scope, false));
    expect(retry.kind).toBe("retry");
    expect(retry.run).toEqual(before);
    const [after] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, scope.failedRunId));
    expect(after).toEqual(before);
    expect(JSON.stringify(events)).not.toContain(bulk.slice(0, 64));
  });

  it.each([{}, { wakeCommentId: null }, { wakeCommentId: false, wakeCommentIds: "invalid", interactionId: [] }])(
    "preserves key presence and JSON types in %j", async context => {
      const scope = await seed(context);
      expect((await readChatAuthorizationRun(db, scope, true)).run?.contextSnapshot).toEqual(context);
    },
  );

  it.each([null, [], "invalid", 42])("handles non-object context %j", async context => {
    const scope = await seed(context);
    expect((await readChatAuthorizationRun(db, scope, true)).run?.contextSnapshot).toEqual(context === null ? null : {});
    expect((await readChatAuthorizationRun(db, scope, false)).run?.contextSnapshot).toEqual(context);
  });

  it("reads current authority and fails closed for another company or agent", async () => {
    const scope = await seed({ source: "chat:slack", taskKey: "CAR-1" });
    expect((await readChatAuthorizationRun(db, scope, true)).run?.contextSnapshot).toEqual({ source: "chat:slack", taskKey: "CAR-1" });
    await db.update(heartbeatRuns).set({ contextSnapshot: { source: "chat:discord", taskKey: "CAR-2" } })
      .where(eq(heartbeatRuns.id, scope.failedRunId));
    expect((await readChatAuthorizationRun(db, scope, true)).run?.contextSnapshot).toEqual({ source: "chat:discord", taskKey: "CAR-2" });
    for (const committed of [true, false]) {
      expect((await readChatAuthorizationRun(db, { ...scope, companyId: randomUUID() }, committed)).run).toBeUndefined();
      expect((await readChatAuthorizationRun(db, { ...scope, agentId: randomUUID() }, committed)).run).toBeUndefined();
      expect((await readChatAuthorizationRun(db, { ...scope, failedRunId: randomUUID() }, committed)).run).toBeUndefined();
    }
  });

  it("preserves nonblocking authorization row locks", async () => {
    const scope = await seed();
    let acquired!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const holder = db.transaction(async tx => {
      await tx.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, scope.failedRunId));
      acquired();
      await released;
    });
    try {
      await ready;
      for (const committed of [true, false]) {
        await expect(db.transaction(tx => readChatAuthorizationRun(tx, scope, committed))).rejects.toMatchObject({ cause: { code: "55P03" } });
      }
    } finally { release(); await holder; }
    expect((await readChatAuthorizationRun(db, scope, true)).run?.status).toBe("running");
  });
});
