import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, chatMessageLinks, createDb, heartbeatRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { captureReviewWaitQueries, seedGitHubReviewCheck, seedGitHubReviewWait,
  type CapturedReviewWaitQuery } from "./helpers/github-review-wait.js";
import { githubReviewCheckState } from "../services/chat-channels/github/review-check-state.js";
import { readInheritedGitHubReviewWait } from "../services/chat-channels/github/review-wait.js";

describe("GitHub review lookups by source comment and delivery", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  beforeAll(async () => {
    if (process.env.PAPERCLIP_TEST_DATABASE_URL) {
      db = createDb(process.env.PAPERCLIP_TEST_DATABASE_URL);
    } else {
      temporary = await startEmbeddedPostgresTestDatabase("github-review-check-state-");
      db = createDb(temporary.connectionString);
    }
  }, 30_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  it("finds only the newest same-agent run woken by the delivery's comment", async () => {
    const f = await seedGitHubReviewCheck(db);
    const other = await seedGitHubReviewWait(db);
    const otherAgentId = randomUUID(), at = (seconds: number) => new Date(Date.now() + seconds * 1_000);
    await db.insert(agents).values({ id: otherAgentId, companyId: f.companyId, name: "Other", adapterType: "process" });
    // A delivery link without a comment cannot select a run.
    await db.insert(chatMessageLinks).values({ companyId: f.companyId, endpointId: f.endpointId,
      conversationId: f.conversationId, deliveryId: f.chatDeliveryId, providerMessageId: "outbound-reply", direction: "outbound" });
    await db.insert(heartbeatRuns).values([
      // Same comment, but another agent or company: never the review's run.
      { companyId: f.companyId, agentId: otherAgentId, status: "succeeded", createdAt: at(60),
        contextSnapshot: { wakeCommentId: f.commentId } },
      { companyId: other.companyId, agentId: other.agentId, status: "succeeded", createdAt: at(60),
        contextSnapshot: { wakeCommentId: f.commentId } },
      // Text comparison: noncanonical, non-string and list-only values do not match.
      { companyId: f.companyId, agentId: f.agentId, status: "failed", createdAt: at(60),
        contextSnapshot: { wakeCommentId: f.commentId.toUpperCase() } },
      { companyId: f.companyId, agentId: f.agentId, status: "failed", createdAt: at(60),
        contextSnapshot: { wakeCommentId: [f.commentId] } },
      { companyId: f.companyId, agentId: f.agentId, status: "failed", createdAt: at(60),
        contextSnapshot: { wakeCommentIds: [f.commentId] } },
      { companyId: f.companyId, agentId: f.agentId, status: "failed", createdAt: at(60), contextSnapshot: null },
      { companyId: f.companyId, agentId: f.agentId, status: "succeeded", createdAt: at(-60),
        contextSnapshot: { wakeCommentId: f.commentId } },
    ]);
    expect(await githubReviewCheckState(db, f.action)).toMatchObject({
      disposition: "publish", run: { id: f.wakeRunId, status: "running" }, state: "running", status: "in_progress",
    });

    const [newest] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId,
      status: "succeeded", createdAt: at(120), contextSnapshot: { wakeCommentId: f.commentId } }).returning();
    expect(await githubReviewCheckState(db, f.action)).toMatchObject({
      run: { id: newest!.id, status: "succeeded" }, state: "incomplete", status: "completed",
    });

    // Another delivery id on the same endpoint selects no run.
    const unmatched = { ...f.action, payload: { ...f.action.payload,
      event: { ...f.event, deliveryId: randomUUID() } } };
    expect(await githubReviewCheckState(db, unmatched)).toMatchObject({ run: undefined, state: "queued" });
  });

  it("reads source comments, deliveries and wake runs through their indexes", async () => {
    const f = await seedGitHubReviewCheck(db);
    const wait = await seedGitHubReviewWait(db);
    // A run history in which each run was woken by another comment. With its
    // statistics, the planner must prefer the wake-comment index to walking
    // the history by creation time.
    await db.$client.unsafe(`insert into heartbeat_runs (company_id, agent_id, status, context_snapshot, created_at)
      select $1::uuid, $2::uuid, 'succeeded', jsonb_build_object('wakeCommentId', gen_random_uuid()::text),
        now() + make_interval(secs => g) from generate_series(1, 2000) g`, [f.companyId, f.agentId]);
    await db.$client.unsafe("analyze heartbeat_runs");
    const queries: CapturedReviewWaitQuery[] = [];
    await githubReviewCheckState(captureReviewWaitQueries(db, queries), f.action);
    await readInheritedGitHubReviewWait(captureReviewWaitQueries(db, queries), wait.run);
    const comments = queries.find(query => query.sql.includes('from "chat_deliveries" inner join "chat_message_links"'));
    const wakeRun = queries.find(query => query.sql.includes('from "heartbeat_runs"') && query.sql.includes("wakeCommentId"));
    const inherited = queries.find(query => query.sql.includes('join "chat_github_reviews"'));
    expect(comments && wakeRun && inherited).toBeTruthy();
    const plan = (query: CapturedReviewWaitQuery) => db.$client.begin(async sql => {
      // Small test tables favour sequential scans; disable them to prove the
      // generated predicates can use the partial indexes at all.
      await sql.unsafe("set local enable_seqscan = off");
      return JSON.stringify(await sql.unsafe(`explain (format json) ${query.sql}`, query.params as never[]));
    });
    const commentsPlan = await plan(comments!), wakeRunPlan = await plan(wakeRun!), inheritedPlan = await plan(inherited!);
    expect(commentsPlan).toContain("chat_deliveries_github_automatic_delivery_idx");
    expect(commentsPlan).toContain("chat_message_links_delivery_idx");
    expect(wakeRunPlan).toContain("heartbeat_runs_company_wake_comment_idx");
    expect(inheritedPlan).toContain("chat_message_links_company_comment_idx");
  });
});
