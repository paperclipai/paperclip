import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issues, nativeRunResults } from "@paperclipai/db";
import { createNativeSessionBackend, type NativeExecutionInput, type PrpEvent, type PrpStructuredRunResult } from "../../vendor/paperclip-runner/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { assertCurrentWakeCommentsRead, READ_CURRENT_WAKE_COMMENTS_TOOL_DEFINITION, resolveCurrentWakeCommentsBinding, type CurrentWakeCommentsPage } from "./current-wake-comments.js";
import { nativeCompletionFeedback } from "./native-completion-feedback.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";

const support = await getEmbeddedPostgresTestSupport();
const report: PrpStructuredRunResult = {
  schema: "paperclip.run_result.v1", reportedWorkDisposition: "done", summary: "Answered the accepted message.",
  completionClaim: { contractRevision: "test", objectiveSatisfied: true, criteria: [], remainingWork: [] },
  evidence: [], verification: [], attentionRequests: [], artifacts: [],
};

describe.skipIf(!support.supported)("current-wake completion feedback", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-wake-feedback-");
    db = createDb(temporary.connectionString);
  }, 120_000);
  afterAll(async () => { await db?.$client.end({ timeout: 0 }); await temporary?.cleanup(); });

  async function seed(bodies = ["Read this complete accepted message."], fallbackFetchNeeded = true) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Wake feedback", issuePrefix: `WF${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Reader", adapterType: "paperclip_runner", status: "running" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Answer the accepted message", status: "in_progress", assigneeAgentId: agentId });
    const comments = await db.insert(issueComments).values(bodies.map(body => ({ companyId, issueId, body, authorType: "user" as const, authorUserId: "local-board" }))).returning();
    const commentIds = comments.map(comment => comment.id);
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, nativeIssueId: issueId,
      runtimeMode: "native", status: "running", resultJson: { existingEvidence: "keep" }, contextSnapshot: {
        issueId, paperclipExternalChatExecutionBound: true, paperclipWake: {
          externalChatProvider: "github", checkedOutByHarness: false, externalChatExecutionBound: true,
          fallbackFetchNeeded, truncated: fallbackFetchNeeded, commentIds, latestCommentId: commentIds.at(-1),
          commentWindow: { requestedCount: commentIds.length, includedCount: commentIds.length, missingCount: 0 },
        },
      } });
    await db.update(issues).set({ executionRunId: runId, executionLockedAt: new Date() }).where(eq(issues.id, issueId));
    const binding = { companyId, agentId, issueId, runId };
    const wake = await resolveCurrentWakeCommentsBinding(db, binding);
    const authority = new PaperclipRunnerToolAuthority(db, { ...binding, currentWakeComments: wake ?? undefined });
    let reads = 0;
    const read = async (cursor?: string | null) => authority.execute({ tool: "read_current_wake_comments", callId: `read-${++reads}`, arguments: { cursor } }) as Promise<CurrentWakeCommentsPage>;
    return { ...binding, comments, wake, read, authority };
  }

  async function finish(value: Awaited<ReturnType<typeof seed>>) {
    return nativeCompletionFeedback(db, value.runId, report);
  }
  async function receipt(value: Awaited<ReturnType<typeof seed>>) {
    return db.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, value.runId)).then(rows => rows[0]!.result);
  }
  async function assertSameRunningTurn(value: Awaited<ReturnType<typeof seed>>) {
    const runs = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, value.companyId), eq(heartbeatRuns.agentId, value.agentId)));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: value.runId, status: "running", resultJson: { existingEvidence: "keep" } });
    expect(await db.select().from(nativeRunResults).where(eq(nativeRunResults.companyId, value.companyId))).toHaveLength(0);
  }

  it("corrects an unread finish before settlement, then accepts the actual reader in the same turn", async () => {
    const value = await seed();
    await expect(finish(value)).rejects.toThrow(/read_current_wake_comments/);
    await assertSameRunningTurn(value);
    const page = await value.read();
    expect(page).toMatchObject({ complete: true, nextCursor: null });
    expect(page.comments[0]?.bodyChunk).toBe(value.comments[0]!.body);
    await expect(finish(value)).resolves.toContain("Completion report accepted");
    await expect(assertCurrentWakeCommentsRead(db, value, value.wake)).resolves.toBeUndefined();
    await assertSameRunningTurn(value);
  });

  it("requires every page before accepting finish", async () => {
    const value = await seed(["A".repeat(16_001)]);
    let page = await value.read();
    expect(page.complete).toBe(false);
    await expect(finish(value)).rejects.toThrow(/read_current_wake_comments/);
    const chunks = page.comments.map(comment => comment.bodyChunk);
    while (!page.complete) {
      page = await value.read(page.nextCursor);
      chunks.push(...page.comments.map(comment => comment.bodyChunk));
    }
    expect(chunks.join("")).toBe(value.comments[0]!.body);
    await expect(finish(value)).resolves.toContain("Completion report accepted");
    await assertSameRunningTurn(value);
  });

  it("corrects a changed snapshot and accepts only a new complete read", async () => {
    const value = await seed();
    await value.read();
    await db.update(issueComments).set({ body: "Revised accepted message", updatedAt: new Date() }).where(eq(issueComments.id, value.comments[0]!.id));
    await expect(finish(value)).rejects.toThrow(/read_current_wake_comments/);
    const page = await value.read();
    expect(page.comments[0]?.bodyChunk).toBe("Revised accepted message");
    await expect(finish(value)).resolves.toContain("Completion report accepted");
    await assertSameRunningTurn(value);
  });

  it("does not accept another company's complete read receipt", async () => {
    const foreign = await seed(), value = await seed();
    await foreign.read();
    const foreignReceipt = (await receipt(foreign))!.currentWakeCommentsReceipt;
    await db.update(heartbeatRuns).set({ resultJson: { existingEvidence: "keep", currentWakeCommentsReceipt: foreignReceipt } }).where(eq(heartbeatRuns.id, value.runId));
    await expect(finish(value)).rejects.toThrow(/read_current_wake_comments/);
    await expect(finish(foreign)).resolves.toContain("Completion report accepted");
    await value.read();
    await expect(finish(value)).resolves.toContain("Completion report accepted");
    await assertSameRunningTurn(value);
  });

  it("keeps inline-complete ordinary completion unchanged", async () => {
    const value = await seed(["The full inline message"], false);
    expect(value.wake).toBeNull();
    await expect(finish(value)).resolves.toContain("Completion report accepted");
    await assertSameRunningTurn(value);
  });

  it("keeps the terminal snapshot fence after early feedback accepts the report", async () => {
    const value = await seed();
    await value.read();
    await expect(finish(value)).resolves.toContain("Completion report accepted");
    await db.update(issueComments).set({ body: "Changed after feedback", updatedAt: new Date() }).where(eq(issueComments.id, value.comments[0]!.id));
    await expect(assertCurrentWakeCommentsRead(db, value, value.wake)).rejects.toThrow("native_current_wake_comments_changed_after_read");
    await assertSameRunningTurn(value);
  });

  it("delivers corrective MCP feedback and completes one OpenCode turn after the real paginated reader", async () => {
    const value = await seed(["A".repeat(16_001)]);
    const root = await mkdtemp(join(tmpdir(), "paperclip-wake-feedback-provider-"));
    const command = join(root, "fake-opencode-server.mjs");
    await copyFile(new URL("../../../../packages/paperclip-runner/test/fixtures/fake-opencode-server.mjs", import.meta.url), command);
    await chmod(command, 0o755);
    const order: string[] = [];
    const sessionId = randomUUID();
    const execution: NativeExecutionInput = {
      schema: "paperclip.native-execution-input.v1",
      binding: { companyId: value.companyId, issueId: value.issueId, runId: value.runId, agentId: value.agentId, executionWorkspaceId: randomUUID() },
      task: { identifier: "WF-1", title: "Read and answer the accepted message", description: null, prompt: "current-wake-completion-feedback", workMode: "standard" },
      workspace: { cwd: root, repoUrl: null, repoRef: null, branchName: null },
      session: { normalizedSessionId: sessionId, driverKind: "opencode_server", protocolVersion: 1, lifecyclePolicy: { mode: "per_turn", idleTimeoutMs: null } },
      provider: { kind: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", permissionMode: "allow" },
      completionContract: { id: "feedback", sha256: "feedback", schemaVersion: "1", contract: { revision: "test", objective: "Answer the accepted message", criteria: [] } },
      interactionResponses: [], credentialBindings: [],
    };
    const backend = createNativeSessionBackend(execution, {
      opencodeRuntimeDirectory: join(root, "runtime"), opencodeCommand: command,
      opencodeEnvironment: { PATH: process.env.PATH, OPENROUTER_API_KEY: "fixture-key" },
      dynamicTools: [READ_CURRENT_WAKE_COMMENTS_TOOL_DEFINITION],
      dynamicToolHandler: async call => {
        order.push("read");
        return value.authority.execute({ tool: call.tool, callId: call.callId, arguments: call.arguments });
      },
      completionFeedback: async result => {
        try {
          const response = await nativeCompletionFeedback(db, value.runId, result);
          order.push("finish-accepted");
          return response;
        } catch (error) { order.push("finish-refused"); throw error; }
      },
    });
    const session = await backend.openSession({ identity: { companyId: value.companyId, runId: value.runId, sessionId, issueId: value.issueId, agentId: value.agentId }, workingDirectory: root });
    try {
      const collected = (async () => {
        const events: PrpEvent[] = [];
        for await (const event of session.events()) {
          events.push(event);
          if (["turn.completed", "turn.failed", "turn.interrupted", "turn.cancelled"].includes(event.eventType)) break;
        }
        return events;
      })();
      await session.startTurn({ message: { role: "user", text: "current-wake-completion-feedback" } });
      const events = await collected;
      expect(order[0]).toBe("finish-refused");
      expect(order.slice(1, -1).length).toBeGreaterThan(1);
      expect(order.slice(1, -1).every(step => step === "read")).toBe(true);
      expect(order.at(-1)).toBe("finish-accepted");
      expect(order.filter(step => step.startsWith("finish"))).toHaveLength(2);
      expect(events.filter(event => event.eventType === "turn.started")).toHaveLength(1);
      expect(events.filter(event => event.eventType === "run.result.proposed")).toHaveLength(1);
      expect(events.at(-1)?.eventType).toBe("turn.completed");
      expect((await session.snapshot()).semanticResult).not.toBeNull();
      const runtime = join(root, "runtime");
      const directories = (await readdir(runtime, { withFileTypes: true })).filter(entry => entry.isDirectory());
      const outcomes = JSON.parse(await readFile(join(runtime, directories[0]!.name, "data/fake-completion-feedback.json"), "utf8"));
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0].result).toMatchObject({ isError: true, content: [{ text: expect.stringContaining("read_current_wake_comments") }] });
      expect(outcomes[1].result.isError).not.toBe(true);
      await expect(assertCurrentWakeCommentsRead(db, value, value.wake)).resolves.toBeUndefined();
      await assertSameRunningTurn(value);
    } finally { await session.close({ reason: "feedback qualification complete" }); await rm(root, { recursive: true, force: true }); }
  }, 60_000);
});
