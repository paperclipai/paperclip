import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  type Db,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";

import {
  assertCurrentWakeCommentsRead,
  readCurrentWakeComments,
  resolveCurrentWakeCommentsBinding,
} from "./current-wake-comments.js";
import { buildPaperclipTaskMarkdown } from "../heartbeat.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping current wake comment reader tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function closeDbClient(db: ReturnType<typeof createDb> | undefined) {
  await db?.$client?.end?.({ timeout: 0 });
}

describeEmbeddedPostgres("current external-chat wake comment reader", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<
    ReturnType<typeof startEmbeddedPostgresTestDatabase>
  > | null = null;

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase(
      "paperclip-current-wake-comments-",
    );
    db = createDb(started.connectionString);
    tempDb = started;
  }, 120_000);

  afterAll(async () => {
    await closeDbClient(db);
    await tempDb?.cleanup();
  });

  async function seed(input: {
    bodies: string[];
    fallbackFetchNeeded?: boolean;
    attachmentOmissionReasons?: Record<string, number>;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const issuePrefix = `W${companyId.replaceAll("-", "").slice(0, 6)}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "local-board",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Chat agent",
      role: "engineer",
      status: "running",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "External chat",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "local-board",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });
    const comments = await db
      .insert(issueComments)
      .values(
        input.bodies.map((body) => ({
          companyId,
          issueId,
          authorType: "user" as const,
          authorUserId: "local-board",
          body,
        })),
      )
      .returning();
    const commentIds = comments.map((comment) => comment.id);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      nativeIssueId: issueId,
      invocationSource: "assignment",
      triggerDetail: "system",
      runtimeMode: "native",
      status: "running",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        paperclipWake: {
          reason: "External chat message received",
          externalChatProvider: "slack",
          checkedOutByHarness: true,
          fallbackFetchNeeded: input.fallbackFetchNeeded ?? true,
          commentIds,
          latestCommentId: commentIds.at(-1),
          commentWindow: {
            requestedCount: commentIds.length,
            includedCount: Math.min(commentIds.length, 8),
            missingCount: Math.max(0, commentIds.length - 8),
          },
          ...(input.attachmentOmissionReasons
            ? {
                attachmentOmissions: [
                  {
                    commentId: commentIds[0],
                    reasons: input.attachmentOmissionReasons,
                  },
                ],
              }
            : {}),
        },
      },
    });
    await db
      .update(issues)
      .set({
        executionRunId: runId,
        executionAgentNameKey: "chat-agent",
        executionLockedAt: new Date(),
      })
      .where(eq(issues.id, issueId));
    return { companyId, agentId, issueId, runId, comments, commentIds };
  }

  it("exposes no reader for an inline-complete wake", async () => {
    const seeded = await seed({
      bodies: ["One complete request"],
      fallbackFetchNeeded: false,
    });
    await expect(
      resolveCurrentWakeCommentsBinding(db, seeded),
    ).resolves.toBeNull();
    await expect(assertCurrentWakeCommentsRead(db, seeded)).resolves.toBe(
      undefined,
    );

    const newlyTruncated = await seed({
      bodies: ["A newly bound overflow request"],
      fallbackFetchNeeded: true,
    });
    await expect(
      assertCurrentWakeCommentsRead(db, newlyTruncated, null),
    ).rejects.toThrow("native_current_wake_comments_binding_changed");
  });

  it("pages every exact accepted comment in order and excludes task history outside the wake", async () => {
    const bodies = Array.from(
      { length: 10 },
      (_, index) => `${index + 1}:${String(index).repeat(4_500)}`,
    );
    const seeded = await seed({ bodies });
    await db.insert(issueComments).values({
      companyId: seeded.companyId,
      issueId: seeded.issueId,
      authorType: "user",
      authorUserId: "local-board",
      body: "This older task-history comment is not part of the accepted wake.",
    });
    const binding = await resolveCurrentWakeCommentsBinding(db, seeded);
    expect(binding?.commentIds).toEqual(seeded.commentIds);
    if (!binding) throw new Error("Expected a current wake reader binding");

    await expect(
      readCurrentWakeComments(db, binding, { cursor: "forged" }),
    ).rejects.toThrow("paperclip_current_wake_comments_cursor_out_of_order");

    let cursor: string | null = null;
    const reconstructed = new Map<string, string>();
    let pageCount = 0;
    while (true) {
      const page = await readCurrentWakeComments(db, binding, { cursor });
      pageCount += 1;
      expect(page.requestedCount).toBe(seeded.commentIds.length);
      for (const chunk of page.comments) {
        reconstructed.set(
          chunk.id,
          `${reconstructed.get(chunk.id) ?? ""}${chunk.bodyChunk}`,
        );
      }
      if (page.complete) {
        expect(page.nextCursor).toBeNull();
        break;
      }
      expect(page.nextCursor).not.toBeNull();
      cursor = page.nextCursor;
    }

    expect(pageCount).toBeGreaterThan(1);
    expect([...reconstructed.keys()]).toEqual(seeded.commentIds);
    expect([...reconstructed.values()]).toEqual(bodies);
    expect(
      [...reconstructed.values()].some((body) =>
        body.includes("older task-history comment"),
      ),
    ).toBe(false);
    await expect(assertCurrentWakeCommentsRead(db, seeded)).resolves.toBe(
      undefined,
    );
  });

  it("requires ordered pages and fails the completion fence after a comment changes", async () => {
    const seeded = await seed({
      bodies: [`first:${"a".repeat(20_000)}`, "second"],
    });
    const binding = await resolveCurrentWakeCommentsBinding(db, seeded);
    if (!binding) throw new Error("Expected a current wake reader binding");

    await expect(assertCurrentWakeCommentsRead(db, seeded)).rejects.toThrow(
      "native_current_wake_comments_unread",
    );
    const first = await readCurrentWakeComments(db, binding, {});
    expect(first.complete).toBe(false);
    expect(first.nextCursor).not.toBeNull();
    await expect(assertCurrentWakeCommentsRead(db, seeded)).rejects.toThrow(
      "native_current_wake_comments_unread",
    );

    const replay = await readCurrentWakeComments(db, binding, {});
    expect(replay).toEqual(first);
    await db
      .update(issueComments)
      .set({ body: "edited after the first page" })
      .where(eq(issueComments.id, seeded.commentIds[0]!));
    await expect(
      readCurrentWakeComments(db, binding, { cursor: first.nextCursor }),
    ).rejects.toThrow("paperclip_current_wake_comments_snapshot_changed");

    const restarted = await readCurrentWakeComments(db, binding, {});
    expect(restarted.snapshotDigest).not.toBe(first.snapshotDigest);
    let page = restarted;
    while (!page.complete) {
      page = await readCurrentWakeComments(db, binding, {
        cursor: page.nextCursor,
      });
    }
    await expect(assertCurrentWakeCommentsRead(db, seeded)).resolves.toBe(
      undefined,
    );

    await db
      .update(issueComments)
      .set({ body: "edited again after the complete read" })
      .where(eq(issueComments.id, seeded.commentIds[1]!));
    await expect(assertCurrentWakeCommentsRead(db, seeded)).rejects.toThrow(
      "native_current_wake_comments_changed_after_read",
    );
  });

  it("surfaces closed attachment omissions and fences their exact snapshot", async () => {
    const seeded = await seed({
      bodies: ["Inspect every current attachment"],
      attachmentOmissionReasons: {
        unsupported_type: 1,
        processing_failed: 1,
        credential_token: 20,
      },
    });
    const binding = await resolveCurrentWakeCommentsBinding(db, seeded);
    expect(binding?.attachmentOmissions).toEqual([
      {
        commentId: seeded.commentIds[0],
        reasons: { unsupported_type: 1, processing_failed: 1 },
      },
    ]);
    if (!binding) throw new Error("Expected a current wake reader binding");

    const page = await readCurrentWakeComments(db, binding, {});
    expect(page.complete).toBe(true);
    expect(page.comments[0]?.attachmentImportNotice).toBe(
      "Paperclip could not import every attachment from this exact external message: 2 attachments were omitted (unsupported type: 1, processing failed: 1). Treat omitted attachments as unavailable; do not infer their contents or substitute an older workspace file.",
    );
    expect(JSON.stringify(page)).not.toContain("credential_token");
    expect(
      buildPaperclipTaskMarkdown({
        issue: {
          id: seeded.issueId,
          identifier: "WAKE-1",
          title: "Inspect the current files",
        },
        wakeComments: [
          {
            id: seeded.commentIds[0]!,
            body: "Inspect every current attachment",
          },
        ],
        attachmentOmissions: [
          {
            commentId: seeded.commentIds[0]!,
            notice: page.comments[0]!.attachmentImportNotice!,
          },
        ],
        externalChatProvider: "discord",
        nativeRunner: true,
      }),
    ).toContain(
      "Treat omitted attachments as unavailable; do not infer their contents or substitute an older workspace file.",
    );
    await expect(assertCurrentWakeCommentsRead(db, seeded)).resolves.toBe(
      undefined,
    );

    const [run] = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, seeded.runId));
    const contextSnapshot = structuredClone(
      run!.contextSnapshot as Record<string, unknown>,
    );
    const wake = contextSnapshot.paperclipWake as Record<string, unknown>;
    wake.attachmentOmissions = [
      {
        commentId: seeded.commentIds[0],
        reasons: { unsupported_type: 2 },
      },
    ];
    await db
      .update(heartbeatRuns)
      .set({ contextSnapshot })
      .where(eq(heartbeatRuns.id, seeded.runId));
    await expect(assertCurrentWakeCommentsRead(db, seeded)).rejects.toThrow(
      "native_current_wake_comments_changed_after_read",
    );
  });

  it("rejects a coalesced comment that arrives between binding resolution and the terminal row lock", async () => {
    const seeded = await seed({ bodies: ["first accepted request"] });
    const binding = await resolveCurrentWakeCommentsBinding(db, seeded);
    if (!binding) throw new Error("Expected a current wake reader binding");
    await expect(
      readCurrentWakeComments(db, binding, {}),
    ).resolves.toMatchObject({ complete: true });

    const [coalesced] = await db
      .insert(issueComments)
      .values({
        companyId: seeded.companyId,
        issueId: seeded.issueId,
        authorType: "user",
        authorUserId: "local-board",
        body: "second request accepted during finalization",
      })
      .returning();
    let injected = false;
    const racingDb = Object.create(db) as ReturnType<typeof createDb>;
    Object.defineProperty(racingDb, "transaction", {
      configurable: true,
      value: async <T>(operation: (tx: Db) => Promise<T>) => {
        if (!injected) {
          injected = true;
          const commentIds = [...seeded.commentIds, coalesced!.id];
          await db
            .update(heartbeatRuns)
            .set({
              contextSnapshot: {
                issueId: seeded.issueId,
                taskId: seeded.issueId,
                paperclipWake: {
                  reason: "External chat message received",
                  externalChatProvider: "slack",
                  checkedOutByHarness: true,
                  fallbackFetchNeeded: true,
                  commentIds,
                  latestCommentId: coalesced!.id,
                  commentWindow: {
                    requestedCount: commentIds.length,
                    includedCount: 1,
                    missingCount: 1,
                  },
                },
              },
            })
            .where(eq(heartbeatRuns.id, seeded.runId));
        }
        return db.transaction((tx) => operation(tx as unknown as Db));
      },
    });

    await expect(
      assertCurrentWakeCommentsRead(racingDb, seeded, binding),
    ).rejects.toThrow("native_current_wake_comments_binding_changed");
  });
});
