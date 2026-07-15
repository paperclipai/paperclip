import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issues,
  linearEvidenceConflicts,
  linearEvidenceDeliveries,
  linearEvidenceMappings,
} from "@paperclipai/db";
import {
  linearEvidenceConnector,
  type LinearCommentReceipt,
  type LinearEvidenceTransport,
} from "./linear-evidence-connector.js";
import {
  buildLinearEvidenceComment,
  linearEvidenceCommentSha256,
  linearEvidenceMappingKey,
  type LinearEvidencePayload,
} from "./linear-evidence-bridge.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("linearEvidenceConnector", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-linear-connector-");
    db = createDb(tempDb.connectionString);
  }, 20_000);
  afterEach(async () => {
    await db.delete(linearEvidenceDeliveries);
    await db.delete(linearEvidenceMappings);
    await db.delete(issues);
    await db.delete(companies);
  });
  afterAll(async () => tempDb?.cleanup());

  async function fixture() {
    const companyId = randomUUID();
    const paperclipIssueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Factory", issuePrefix: "FAS", requireBoardApprovalForNewAgents: false });
    await db.insert(issues).values({ id: paperclipIssueId, companyId, identifier: "FAS-112", issueNumber: 112, title: "Bridge", status: "in_progress", priority: "high" });
    const [issue] = await db.select().from(issues);
    const linearIssueId = "linear-all-387";
    const evidence: LinearEvidencePayload = {
      contractVersion: 1,
      mappingKey: linearEvidenceMappingKey(companyId, paperclipIssueId),
      paperclipIssueId,
      paperclipIssueUpdatedAt: issue!.updatedAt.toISOString(),
      linearIssueId,
      implementerId: "codex",
      whatChanged: "Added an idempotent evidence connector.",
      artifact: { sha256: "a".repeat(64) },
      verification: { verifierId: "lana", independent: true, result: "passed", summary: "Focused tests passed.", testedAt: "2026-07-15T18:00:00.000Z" },
      recordedAt: "2026-07-15T18:01:00.000Z",
    };
    return { companyId, paperclipIssueId, linearIssueId, evidence };
  }

  it("publishes once and reuses the concrete read-after-write receipt", async () => {
    const input = await fixture();
    const comments = new Map<string, LinearCommentReceipt>();
    const transport: LinearEvidenceTransport = {
      findCommentByMarker: vi.fn(async ({ marker }) => [...comments.values()].find((comment) => comment.body.includes(marker)) ?? null),
      createComment: vi.fn(async ({ linearIssueId, body }) => {
        const id = "comment-1";
        comments.set(id, { id, linearIssueId, body, createdAt: "2026-07-15T18:02:00.000Z" });
        return { id };
      }),
      getComment: vi.fn(async ({ commentId }) => comments.get(commentId) ?? null),
    };
    const connector = linearEvidenceConnector(db, transport);
    const first = await connector.publish(input);
    const second = await connector.publish(input);
    expect(first.delivery.state).toBe("published");
    expect(second.delivery.remoteCommentId).toBe("comment-1");
    expect(first.delivery.commentBodySha256).toBe(linearEvidenceCommentSha256(input.evidence));
    expect([...comments.values()][0]?.body).toBe(buildLinearEvidenceComment(input.evidence));
    expect(transport.createComment).toHaveBeenCalledTimes(1);
    expect((await db.select().from(linearEvidenceDeliveries))).toHaveLength(1);
  });

  it("dry-run persists one pending idempotency record without calling Linear", async () => {
    const input = await fixture();
    const transport: LinearEvidenceTransport = {
      findCommentByMarker: vi.fn(),
      createComment: vi.fn(),
      getComment: vi.fn(),
    };
    const connector = linearEvidenceConnector(db, transport);
    await connector.publish({ ...input, dryRun: true });
    const retry = await connector.publish({ ...input, dryRun: true });
    expect(retry.delivery.state).toBe("pending");
    expect(transport.createComment).not.toHaveBeenCalled();
    expect((await db.select().from(linearEvidenceDeliveries))).toHaveLength(1);
  });

  it("reconciles by marker after an ambiguous accepted create without duplicating the comment", async () => {
    const input = await fixture();
    const comments = new Map<string, LinearCommentReceipt>();
    const transport: LinearEvidenceTransport = {
      findCommentByMarker: vi.fn(async ({ marker }) => [...comments.values()].find((comment) => comment.body.includes(marker)) ?? null),
      createComment: vi.fn(async ({ linearIssueId, body }) => {
        comments.set("comment-accepted", {
          id: "comment-accepted",
          linearIssueId,
          body,
          createdAt: "2026-07-15T18:02:00.000Z",
        });
        throw new Error("connection closed after remote acceptance");
      }),
      getComment: vi.fn(),
    };
    const connector = linearEvidenceConnector(db, transport);

    await expect(connector.publish(input)).rejects.toMatchObject({ code: "delivery_ambiguous" });
    const receipt = await connector.publish(input);
    expect(receipt.delivery).toMatchObject({ state: "published", remoteCommentId: "comment-accepted" });
    expect(transport.createComment).toHaveBeenCalledTimes(1);
    expect(transport.getComment).not.toHaveBeenCalled();
    expect((await db.select().from(linearEvidenceDeliveries))).toHaveLength(1);
  });

  it("rejects stale Paperclip versions before state persistence or remote access", async () => {
    const input = await fixture();
    await db.update(issues).set({ updatedAt: new Date("2026-07-15T18:05:00.000Z") })
      .where(eq(issues.id, input.paperclipIssueId));
    const transport: LinearEvidenceTransport = {
      findCommentByMarker: vi.fn(),
      createComment: vi.fn(),
      getComment: vi.fn(),
    };
    const connector = linearEvidenceConnector(db, transport);

    await expect(connector.publish(input)).rejects.toMatchObject({ code: "stale_version" });
    expect(transport.findCommentByMarker).not.toHaveBeenCalled();
    expect(await db.select().from(linearEvidenceMappings)).toHaveLength(0);
    expect(await db.select().from(linearEvidenceDeliveries)).toHaveLength(0);
  });

  it("preserves exact remote body conflicts and refuses a successful receipt", async () => {
    const input = await fixture();
    const transport: LinearEvidenceTransport = {
      findCommentByMarker: vi.fn(async () => null),
      createComment: vi.fn(async () => ({ id: "comment-mutated" })),
      getComment: vi.fn(async ({ linearIssueId, commentId }) => ({
        id: commentId,
        linearIssueId,
        body: `${buildLinearEvidenceComment(input.evidence)}\nmutated`,
        createdAt: "2026-07-15T18:02:00.000Z",
      })),
    };
    const connector = linearEvidenceConnector(db, transport);

    await expect(connector.publish(input)).rejects.toMatchObject({ code: "remote_conflict" });
    expect(await db.select().from(linearEvidenceConflicts)).toHaveLength(1);
    expect((await db.select().from(linearEvidenceDeliveries))[0]).toMatchObject({
      state: "conflict",
      remoteCommentId: null,
      lastErrorCode: "remote_conflict",
    });
  });
});
