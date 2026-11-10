import { randomBytes, randomUUID } from "node:crypto";
import { agents, companies, createDb, heartbeatRuns } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { isExternalChatPresentationContext } from "../heartbeat-run-summary.js";
import { legacyDispositionEpisode } from "./legacy-continuation.js";
import { decideIssueReviewPathRecovery } from "./review-path-recovery.js";
import { recoveryRunContextColumn, recoveryRunVersionColumn } from "./run-context-read.js";

const support = await getEmbeddedPostgresTestSupport();

describe.skipIf(!support.supported)("recovery context PostgreSQL projection", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("recovery-context-read-");
    db = createDb(database.connectionString);
    const [company] = await db.insert(companies).values({ name: "Recovery fixture", issuePrefix: "RC" }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Recovery agent", adapterType: "process" }).returning();
    companyId = company.id;
    agentId = agent.id;
  }, 60_000);
  afterAll(async () => {
    await db?.$client.end();
    await database?.cleanup();
  });

  async function read(contextSnapshot: unknown) {
    const [run] = await db.insert(heartbeatRuns).values({ companyId, agentId, contextSnapshot: contextSnapshot as Record<string, unknown> | null }).returning();
    const [selected] = await db.select({ context: recoveryRunContextColumn, version: recoveryRunVersionColumn })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    return { run, selected };
  }

  it("retains typed recovery evidence while excluding large execution data", async () => {
    const issueId = randomUUID();
    const payload = randomBytes(128 * 1024).toString("base64");
    const evidence = {
      issueId, taskId: issueId, retryReason: "issue_continuation_needed", source: "chat:slack",
      wakeReason: "assignment", handoffReason: "successful_run_missing_state", handoffRequired: true,
      handoffAttempt: 2, maxHandoffAttempts: 3, sourceRunId: randomUUID(), resumeFromRunId: randomUUID(),
      missingDisposition: "clear_next_step", providerQuotaRetryNotBefore: "2099-01-01T00:00:00Z",
      transientRetryNotBefore: "2099-01-02T00:00:00Z", dispositionRepairAttempt: 2,
      dispositionRepairFingerprint: "fingerprint", legacyDispositionEpisode: { id: "episode", attempt: 1, maxAttempts: 2 },
      reviewPathRecoveryAttempt: 1, reviewPathConsumedRef: "reference", interactionId: randomUUID(),
      approvalId: randomUUID(), clearReason: "resolved", monitorAttemptCount: 4,
      wakeCommentIds: [randomUUID(), randomUUID()], wakeCommentId: randomUUID(), commentId: randomUUID(),
      externalChatContinuation: true,
    };
    const context = { ...evidence, paperclipWake: { externalInteractionContinuation: true, prompt: payload },
      paperclipWorkspace: { mode: "shared_workspace", instructions: payload }, executionContinuation: { prompt: payload }, paperclipTaskMarkdown: payload };
    const { run, selected } = await read(context);
    expect(selected.context).toEqual({ ...evidence, paperclipWake: { externalInteractionContinuation: true }, paperclipWorkspace: { mode: "shared_workspace" } });
    expect(Buffer.byteLength(JSON.stringify(selected))).toBeLessThan(4096);
    expect(isExternalChatPresentationContext(selected.context)).toBe(isExternalChatPresentationContext(context));
    expect(legacyDispositionEpisode({ ...run, contextSnapshot: selected.context })).toEqual(legacyDispositionEpisode(run));
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(stored.contextSnapshot).toEqual(context);
    const [serialized] = await db.$client.unsafe("SELECT xmin::text AS version FROM heartbeat_runs WHERE id = $1", [run.id]);
    expect(selected.version).toBe(serialized.version);
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...context, paperclipTaskMarkdown: "changed" } }).where(eq(heartbeatRuns.id, run.id));
    const [changed] = await db.select({ context: recoveryRunContextColumn, version: recoveryRunVersionColumn }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(changed.context).toEqual(selected.context);
    expect(changed.version).not.toBe(selected.version);
  });

  it.each([null, [], ["unexpected"], "scalar", 42, { issueId: 42, taskId: false, paperclipWake: [], paperclipWorkspace: null }].map(context => ({ context })))("preserves decisions for malformed context $context", async ({ context }) => {
    const { selected } = await read(context);
    expect(isExternalChatPresentationContext(selected.context)).toBe(isExternalChatPresentationContext(context));
    expect(legacyDispositionEpisode({ id: "run", contextSnapshot: selected.context })).toEqual(legacyDispositionEpisode({ id: "run", contextSnapshot: context }));
  });

  it("retains external-chat review recovery message references and monitor identity", async () => {
    const context = { source: "chat:slack", wakeReason: "issue_monitor_fired", clearReason: "fired", monitorAttemptCount: 3,
      wakeCommentIds: [randomUUID(), randomUUID()], prompt: randomBytes(64 * 1024).toString("base64") };
    const { selected } = await read(context);
    const input = { issueId: randomUUID(), sourceRunId: randomUUID(), assigneeAgentId: agentId, reviewAttention: { state: "stalled" } as Parameters<typeof decideIssueReviewPathRecovery>[0]["reviewAttention"], existingWake: false };
    expect(decideIssueReviewPathRecovery({ ...input, contextSnapshot: selected.context }))
      .toEqual(decideIssueReviewPathRecovery({ ...input, contextSnapshot: context }));
  });
});
