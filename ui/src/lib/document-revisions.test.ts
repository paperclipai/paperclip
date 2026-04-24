import type { DocumentRevision, IssueDocument } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import { deriveDocumentRevisionState } from "./document-revisions";

function createDocument(overrides: Partial<IssueDocument> = {}): IssueDocument {
  return {
    id: "document-1",
    companyId: "company-1",
    issueId: "issue-1",
    key: "plan",
    title: "Plan",
    format: "markdown",
    body: "# Current plan",
    latestRevisionId: "revision-2",
    latestRevisionNumber: 2,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    updatedByAgentId: "agent-1",
    updatedByUserId: null,
    createdAt: new Date("2026-04-10T15:00:00.000Z"),
    updatedAt: new Date("2026-04-10T16:00:00.000Z"),
    ...overrides,
  };
}

function createRevision(overrides: Partial<DocumentRevision> = {}): DocumentRevision {
  return {
    id: "revision-1",
    companyId: "company-1",
    documentId: "document-1",
    issueId: "issue-1",
    key: "plan",
    revisionNumber: 1,
    title: "Plan",
    format: "markdown",
    body: "# Revision body",
    changeSummary: null,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    createdAt: new Date("2026-04-10T15:00:00.000Z"),
    ...overrides,
  };
}

describe("deriveDocumentRevisionState", () => {
  it("falls back to a synthetic current revision when no revision history has been fetched yet", () => {
    const state = deriveDocumentRevisionState(createDocument({
      latestRevisionId: null,
      latestRevisionNumber: 0,
      body: "# Draft plan",
    }), []);

    expect(state.currentRevision.id).toBe("document-1-latest");
    expect(state.currentRevision.body).toBe("# Draft plan");
    expect(state.revisions.map((revision) => revision.id)).toEqual(["document-1-latest"]);
  });

  it("sorts fetched revisions newest-first even when the API payload is out of order", () => {
    const state = deriveDocumentRevisionState(createDocument(), [
      createRevision({ id: "revision-1", revisionNumber: 1, createdAt: new Date("2026-04-10T15:00:00.000Z") }),
      createRevision({ id: "revision-2", revisionNumber: 2, body: "# Current plan", createdAt: new Date("2026-04-10T16:00:00.000Z") }),
    ]);

    expect(state.currentRevision.id).toBe("revision-2");
    expect(state.revisions.map((revision) => revision.id)).toEqual(["revision-2", "revision-1"]);
  });

  it("keeps the latest document revision current when the revision history cache is stale", () => {
    const state = deriveDocumentRevisionState(createDocument(), [
      createRevision({ id: "revision-1", revisionNumber: 1, body: "# Original plan" }),
    ]);

    expect(state.currentRevision.id).toBe("revision-2");
    expect(state.currentRevision.body).toBe("# Current plan");
    expect(state.revisions.map((revision) => revision.id)).toEqual(["revision-2", "revision-1"]);
  });

  it("trusts the fetched revision history when it is newer than the document summary cache", () => {
    const staleDocument = createDocument({
      body: "# Original plan",
      latestRevisionId: "revision-1",
      latestRevisionNumber: 1,
      updatedAt: new Date("2026-04-10T15:00:00.000Z"),
    });

    const state = deriveDocumentRevisionState(staleDocument, [
      createRevision({ id: "revision-2", revisionNumber: 2, body: "# Current plan", createdAt: new Date("2026-04-10T16:00:00.000Z") }),
      createRevision({ id: "revision-1", revisionNumber: 1, body: "# Original plan", createdAt: new Date("2026-04-10T15:00:00.000Z") }),
    ]);

    expect(state.currentRevision.id).toBe("revision-2");
    expect(state.currentRevision.body).toBe("# Current plan");
    expect(state.revisions.map((revision) => revision.id)).toEqual(["revision-2", "revision-1"]);
  });
});
