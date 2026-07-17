import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  issueComments,
  issues,
  issueThreadInteractions,
  releaseCandidateAuditEvents,
  releaseCandidates,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { releaseCandidateService } from "../services/release-candidates.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("releaseCandidateService with PostgreSQL", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-release-candidates-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(releaseCandidateAuditEvents);
    await db.delete(issueComments);
    await db.delete(releaseCandidates);
    await db.delete(issueThreadInteractions);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("binds approval when PostgreSQL stores sub-millisecond updated_at precision", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const candidateId = randomUUID();
    const interactionId = randomUUID();
    const imageDigest = `sha256:${"1".repeat(64)}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `RC${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Approve release candidate",
    });
    await db.insert(releaseCandidates).values({
      id: candidateId,
      companyId,
      sourceIssueId: issueId,
      commitSha: "abc1234567890",
      imageDigest,
      signatureBundleRef: "oci://registry.example/scanner/signature",
      signatureBundleSha256: "2".repeat(64),
      provenanceRef: "https://github.example/workflows/1/provenance",
      sbomHash: "3".repeat(64),
      workflowRunUrl: "https://github.example/workflows/1",
      environment: "production",
      targetHost: "srv1749248",
      sequence: 42,
    });
    await db.insert(issueThreadInteractions).values({
      id: interactionId,
      companyId,
      issueId,
      kind: "request_confirmation",
      payload: {
        version: 1,
        prompt: "Approve release candidate?",
        target: {
          type: "custom",
          key: `release_candidate:${candidateId}`,
          revisionId: imageDigest,
        },
      },
    });

    await db.execute(sql`
      update ${releaseCandidates}
      set updated_at = ${"2026-07-17T12:37:42.176545Z"}::timestamptz
      where id = ${candidateId}
    `);

    const candidate = await releaseCandidateService(db).getById(candidateId);
    expect(candidate?.updatedAt.toISOString()).toBe("2026-07-17T12:37:42.176Z");

    const interaction = await db
      .select()
      .from(issueThreadInteractions)
      .then((rows) => rows[0]);
    const updated = await releaseCandidateService(db).markApprovalInteractionCreated(
      candidateId,
      interaction!,
      { userId: "founder" },
    );

    expect(updated).toMatchObject({
      id: candidateId,
      approvalInteractionId: interactionId,
      status: "approval_requested",
    });
  });
});
