import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { undeliveredLegacyUserCommentIds } from "./explicit-native-continuation.js";
import { PaperclipRunnerToolAuthority } from "./native-runtime/paperclip-runner-tool-authority.js";
import { taskHistoryReadsForRun } from "./queued-comment-delivery.js";

const support = await getEmbeddedPostgresTestSupport();
const USER = "history-read-user";

describe.skipIf(!support.supported)("task history reads", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-history-read-");
    db = createDb(database.connectionString);
  }, EMBEDDED_POSTGRES_TEST_TIMEOUT_MS);
  afterAll(async () => { await db?.$client.end(); await database?.cleanup(); });

  async function seed() {
    const [company] = await db.insert(companies).values({ name: "History read", issuePrefix: `H${randomUUID().slice(0, 4)}` }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Codie", adapterType: "paperclip_runner" }).returning();
    const issueId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "running",
      runtimeMode: "native", runtimeModeResolvedAt: new Date(), nativeIssueId: issueId,
      startedAt: new Date(Date.now() - 60_000), contextSnapshot: { issueId } }).returning();
    await db.insert(issues).values({ id: issueId, companyId: company!.id, title: "Fix the reports", status: "in_progress",
      assigneeAgentId: agent!.id, executionRunId: run!.id });
    return { companyId: company!.id, agentId: agent!.id, issueId, runId: run!.id };
  }

  const comment = async (f: Awaited<ReturnType<typeof seed>>, body: string) => (await db.insert(issueComments).values({
    companyId: f.companyId, issueId: f.issueId, authorType: "user", authorUserId: USER, body }).returning())[0]!;

  async function readHistory(f: Awaited<ReturnType<typeof seed>>) {
    const reader = new PaperclipRunnerToolAuthority(db, { companyId: f.companyId, agentId: f.agentId, issueId: f.issueId, runId: f.runId });
    try { await reader.execute({ tool: "get_task_history", callId: randomUUID(), arguments: {} }); } finally { reader.close(); }
  }

  const finish = (f: { runId: string }, status: "succeeded" | "failed") => db.update(heartbeatRuns)
    .set({ status, finishedAt: new Date(Date.now() + 1_000) }).where(eq(heartbeatRuns.id, f.runId));

  it("lists the comments a failed run read, with the read time and the revision it saw", async () => {
    const f = await seed();
    const first = await comment(f, "Also include the FOLLOWUP line.");
    const second = await comment(f, "And keep the ledger sorted.");
    const before = new Date();
    await readHistory(f);
    await finish(f, "failed");
    const reads = await taskHistoryReadsForRun(db, { companyId: f.companyId, runId: f.runId });
    expect(reads.map(read => read.commentId).sort()).toEqual([first.id, second.id].sort());
    for (const read of reads) {
      const seen = read.commentId === first.id ? first : second;
      expect(read.revision.toISOString()).toBe(seen.updatedAt.toISOString());
      expect(read.readAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1_000);
    }
    expect(await taskHistoryReadsForRun(db, { companyId: randomUUID(), runId: f.runId })).toEqual([]);
  });

  const citeAsHandled = (f: Awaited<ReturnType<typeof seed>>, commentId: string) => db.insert(heartbeatRunEvents).values({
    companyId: f.companyId, runId: f.runId, agentId: f.agentId, seq: 100_000, eventType: "run.result.accepted", stream: "system", level: "info",
    payload: { prpEvent: { payload: { result: { schema: "paperclip.run_result.v1", evidence: [],
      completionClaim: { criteria: [{ criterionId: "objective", status: "satisfied", evidenceRefs: [`comment:${commentId}`] }] } } } } } });

  it.each([
    { status: "succeeded" as const, cited: true, owed: false },
    { status: "succeeded" as const, cited: false, owed: true },
    { status: "failed" as const, cited: true, owed: true },
  ])("treats a remote-stop follow-up that a $status run read mid-turn (cited: $cited) as owed: $owed", async ({ status, cited, owed }) => {
    const f = await seed();
    const followUp = await comment(f, "Additional requirement: include the FOLLOWUP line.");
    await readHistory(f);
    if (cited) await citeAsHandled(f, followUp.id);
    await finish(f, status);
    expect(await undeliveredLegacyUserCommentIds(db, f.companyId, f.issueId, f.agentId, [followUp.id]))
      .toEqual(owed ? [followUp.id] : []);
  });
});
