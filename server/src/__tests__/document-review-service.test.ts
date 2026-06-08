import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  companies,
  createDb,
  documentAnnotationAnchorSnapshots,
  documentAnnotationComments,
  documentAnnotationThreads,
  documentReviewComments,
  documentReviewThreads,
  documentRevisions,
  documentSuggestionAnchorSnapshots,
  documentSuggestionComments,
  documentSuggestions,
  documents,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { documentReviewService } from "../services/document-review.js";
import { documentService } from "../services/documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres document review service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("documentReviewService", () => {
  let db!: ReturnType<typeof createDb>;
  let docs!: ReturnType<typeof documentService>;
  let review!: ReturnType<typeof documentReviewService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-document-review-");
    db = createDb(tempDb.connectionString);
    docs = documentService(db);
    review = documentReviewService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(documentSuggestionAnchorSnapshots);
    await db.delete(documentSuggestionComments);
    await db.delete(documentSuggestions);
    await db.delete(documentReviewComments);
    await db.delete(documentReviewThreads);
    await db.delete(documentAnnotationAnchorSnapshots);
    await db.delete(documentAnnotationComments);
    await db.delete(documentAnnotationThreads);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createIssueWithDocument(body = "Alpha selected text omega") {
    const companyId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "PAP-10523",
      title: "Review backend",
      description: "Validate document review primitives",
      status: "in_progress",
      priority: "medium",
    });

    const created = await docs.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body,
    });

    return { companyId, issueId, document: created.document };
  }

  const selectedTextSelector = {
    quote: { exact: "selected text", prefix: "Alpha ", suffix: " omega" },
    position: { normalizedStart: 6, normalizedEnd: 19, markdownStart: 6, markdownEnd: 19 },
  };

  it("indexes document-level review threads and pending suggestions for agents", async () => {
    const { issueId, document } = await createIssueWithDocument();

    await review.createReviewThread(
      issueId,
      "plan",
      { body: "Overall: tighten this document." },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );
    const suggestion = await review.createSuggestion(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        kind: "substitution",
        selector: selectedTextSelector,
        proposedText: "better text",
        body: "Suggested replacement.",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    const index = await review.getReviewIndex(issueId, "plan", { includeComments: true });

    expect(index.counts.unresolved).toBe(2);
    expect(index.counts.openReviewThreads).toBe(1);
    expect(index.counts.pendingSuggestions).toBe(1);
    expect(index.reviewThreads[0]?.comments[0]?.body).toBe("Overall: tighten this document.");
    expect(index.suggestions[0]?.id).toBe(suggestion.id);
    expect(index.suggestions[0]?.comments[0]?.body).toBe("Suggested replacement.");
  });

  it("accepts a suggestion by creating an auditable document revision", async () => {
    const { issueId, document } = await createIssueWithDocument();
    const suggestion = await review.createSuggestion(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        kind: "substitution",
        selector: selectedTextSelector,
        proposedText: "better text",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    const accepted = await review.acceptSuggestion(
      issueId,
      "plan",
      suggestion.id,
      { baseRevisionId: document.latestRevisionId!, changeSummary: "Accept suggested wording" },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    expect(accepted.document.body).toBe("Alpha better text omega");
    expect(accepted.suggestion.status).toBe("accepted");
    expect(accepted.suggestion.acceptedRevisionId).toBe(accepted.revision.id);
    const revisions = await docs.listIssueDocumentRevisions(issueId, "plan");
    expect(revisions.map((revision) => revision.changeSummary)).toContain("Accept suggested wording");
    const index = await review.getReviewIndex(issueId, "plan", { status: "all" });
    expect(index.counts.pendingSuggestions).toBe(0);
    expect(index.counts.acceptedSuggestions).toBe(1);
  });

  it("resolves a suggestion without editing the document, distinct from rejection", async () => {
    const { issueId, document } = await createIssueWithDocument();
    const suggestion = await review.createSuggestion(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        kind: "substitution",
        selector: selectedTextSelector,
        proposedText: "better text",
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    const resolved = await review.resolveSuggestion(
      issueId,
      "plan",
      suggestion.id,
      { note: "Handled in a follow-up edit." },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );

    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedByUserId).toBe("board-user");
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    // Resolving must not mutate the document body or create a revision.
    const revisions = await docs.listIssueDocumentRevisions(issueId, "plan");
    expect(revisions).toHaveLength(1);

    const index = await review.getReviewIndex(issueId, "plan", { status: "all" });
    expect(index.counts.pendingSuggestions).toBe(0);
    expect(index.counts.resolvedSuggestions).toBe(1);
    expect(index.counts.rejectedSuggestions).toBe(0);

    // A resolved suggestion is terminal — it can't be resolved or rejected again.
    await expect(
      review.resolveSuggestion(issueId, "plan", suggestion.id, {}, { actorType: "user", actorId: "board-user", userId: "board-user" }),
    ).rejects.toThrow(/Only pending suggestions can be resolved/);
  });

  it("remaps pending suggestions across document revisions before acceptance", async () => {
    const { issueId, document } = await createIssueWithDocument();
    const suggestion = await review.createSuggestion(
      issueId,
      "plan",
      {
        baseRevisionId: document.latestRevisionId!,
        baseRevisionNumber: document.latestRevisionNumber,
        kind: "deletion",
        selector: selectedTextSelector,
      },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );
    const updated = await docs.upsertIssueDocument({
      issueId,
      key: "plan",
      title: "Plan",
      format: "markdown",
      body: "Beta selected text omega",
      baseRevisionId: document.latestRevisionId!,
      changeSummary: "Manual edit before suggestion acceptance",
    });

    const remapped = await review.remapOpenSuggestionsForDocument({
      issueId,
      key: "plan",
      documentId: document.id,
      nextRevisionId: updated.document.latestRevisionId,
      nextRevisionNumber: updated.document.latestRevisionNumber,
      nextBody: updated.document.body,
    });

    expect(remapped).toHaveLength(1);
    expect(remapped[0]?.suggestion.id).toBe(suggestion.id);
    expect(remapped[0]?.suggestion.anchorState).toBe("active");
    expect(remapped[0]?.suggestion.markdownStart).toBe(5);

    const accepted = await review.acceptSuggestion(
      issueId,
      "plan",
      suggestion.id,
      { baseRevisionId: updated.document.latestRevisionId! },
      { actorType: "user", actorId: "board-user", userId: "board-user" },
    );
    expect(accepted.document.body).toBe("Beta  omega");
  });
});
