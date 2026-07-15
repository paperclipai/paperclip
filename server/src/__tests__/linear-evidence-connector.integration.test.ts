import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  issues,
  linearEvidenceDeliveries,
  linearEvidenceMappings,
} from "@paperclipai/db";
import { createLinearEvidenceTransport } from "../../../packages/linear-evidence-transport/src/index.js";
import {
  buildLinearEvidenceComment,
  linearEvidenceCommentSha256,
  linearEvidenceMappingKey,
  type LinearEvidencePayload,
} from "../services/linear-evidence-bridge.js";
import { linearEvidenceConnector } from "../services/linear-evidence-connector.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePg = support.supported ? describe : describe.skip;

describePg("Linear evidence connector and credential transport integration", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-linear-boundary-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(linearEvidenceDeliveries);
    await db.delete(linearEvidenceMappings);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => tempDb?.cleanup());

  it("publishes exact evidence once through SecretRef resolution and returns the read-after-write receipt", async () => {
    const companyId = randomUUID();
    const paperclipIssueId = randomUUID();
    const linearIssueId = "ALL-387";
    await db.insert(companies).values({
      id: companyId,
      name: "Factory",
      issuePrefix: "FAS",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: paperclipIssueId,
      companyId,
      identifier: "FAS-112",
      issueNumber: 112,
      title: "Linear evidence bridge",
      status: "in_progress",
      priority: "high",
    });
    const [issue] = await db.select().from(issues);
    const evidence: LinearEvidencePayload = {
      contractVersion: 1,
      mappingKey: linearEvidenceMappingKey(companyId, paperclipIssueId),
      paperclipIssueId,
      paperclipIssueUpdatedAt: issue!.updatedAt.toISOString(),
      linearIssueId,
      implementerId: "simon",
      whatChanged: "Implemented the production Linear evidence connector boundary.",
      artifact: { sha256: "a".repeat(64) },
      verification: {
        verifierId: "lana",
        independent: true,
        result: "passed",
        summary: "Independent connector verification passed.",
        testedAt: "2026-07-15T19:40:00.000Z",
      },
      recordedAt: "2026-07-15T19:41:00.000Z",
    };
    const comments = new Map<string, { id: string; body: string; createdAt: string }>();
    let createCalls = 0;
    const fakeAuthorization = "lin_api_integration-fixture-only";
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(fakeAuthorization);
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { body?: string; commentId?: string };
      };
      expect(JSON.stringify(request)).not.toContain(fakeAuthorization);
      if (request.query.includes("PaperclipFindEvidenceComment")) {
        return new Response(JSON.stringify({ data: { issue: {
          id: "linear-issue-uuid",
          identifier: linearIssueId,
          comments: {
            nodes: [...comments.values()].map((comment) => ({
              ...comment,
              issue: { id: "linear-issue-uuid", identifier: linearIssueId },
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        } } }), { status: 200 });
      }
      if (request.query.includes("PaperclipCreateEvidenceComment")) {
        createCalls += 1;
        comments.set("comment-387", {
          id: "comment-387",
          body: request.variables.body!,
          createdAt: "2026-07-15T19:42:00.000Z",
        });
        return new Response(JSON.stringify({ data: { commentCreate: {
          success: true,
          comment: { id: "comment-387" },
        } } }), { status: 200 });
      }
      const comment = comments.get(request.variables.commentId!);
      return new Response(JSON.stringify({ data: { comment: comment ? {
        ...comment,
        issue: { id: "linear-issue-uuid", identifier: linearIssueId },
      } : null } }), { status: 200 });
    });
    const secretResolver = { resolve: vi.fn(async () => fakeAuthorization) };
    const transport = createLinearEvidenceTransport({
      authorizationSecretRef: {
        type: "secret_ref",
        secretId: "77777777-7777-4777-8777-777777777777",
        version: "latest",
      },
      secretResolver,
      fetch: fetchImpl,
    });
    const connector = linearEvidenceConnector(db, transport);

    const first = await connector.publish({ companyId, paperclipIssueId, linearIssueId, evidence });
    const replay = await connector.publish({ companyId, paperclipIssueId, linearIssueId, evidence });

    expect(first.delivery).toEqual({
      state: "published",
      idempotencyKey: first.idempotencyKey,
      commentBodySha256: linearEvidenceCommentSha256(evidence),
      remoteCommentId: "comment-387",
      publishedAt: "2026-07-15T19:42:00.000Z",
    });
    expect(replay.delivery).toEqual(first.delivery);
    expect(comments.get("comment-387")?.body).toBe(buildLinearEvidenceComment(evidence));
    expect(createCalls).toBe(1);
    expect(secretResolver.resolve).toHaveBeenCalledTimes(3);
    expect(secretResolver.resolve.mock.calls.map(([input]) => input.operation)).toEqual([
      "find_comment",
      "create_comment",
      "get_comment",
    ]);
    expect(JSON.stringify(first)).not.toContain(fakeAuthorization);
  });
});
