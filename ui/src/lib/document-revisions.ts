import type { DocumentRevision, IssueDocument } from "@paperclipai/shared";

type DocumentRevisionState = {
  currentRevision: DocumentRevision;
  revisions: DocumentRevision[];
};

function toTimestamp(value: Date | string | null | undefined) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function sortRevisionsDescending(revisions: DocumentRevision[]) {
  return [...revisions].sort((a, b) => {
    if (a.revisionNumber !== b.revisionNumber) {
      return b.revisionNumber - a.revisionNumber;
    }
    const createdAtDelta = toTimestamp(b.createdAt) - toTimestamp(a.createdAt);
    if (createdAtDelta !== 0) return createdAtDelta;
    return b.id.localeCompare(a.id);
  });
}

function createCurrentRevisionSnapshot(document: IssueDocument): DocumentRevision {
  return {
    id: document.latestRevisionId ?? `${document.id}-latest`,
    companyId: document.companyId,
    documentId: document.id,
    issueId: document.issueId,
    key: document.key,
    revisionNumber: document.latestRevisionNumber,
    title: document.title,
    format: document.format,
    body: document.body,
    changeSummary: null,
    createdByAgentId: document.updatedByAgentId ?? document.createdByAgentId,
    createdByUserId: document.updatedByUserId ?? document.createdByUserId,
    createdAt: document.updatedAt,
  };
}

export function deriveDocumentRevisionState(
  document: IssueDocument,
  revisions: DocumentRevision[],
): DocumentRevisionState {
  const sortedRevisions = sortRevisionsDescending(revisions);
  const currentSnapshot = createCurrentRevisionSnapshot(document);
  const highestFetchedRevision = sortedRevisions[0] ?? null;
  const documentAppearsStale = Boolean(
    highestFetchedRevision && highestFetchedRevision.revisionNumber > document.latestRevisionNumber,
  );

  const currentRevision = documentAppearsStale
    ? highestFetchedRevision!
    : sortedRevisions.find((revision) => revision.id === document.latestRevisionId) ?? currentSnapshot;

  const revisionsWithCurrent = sortRevisionsDescending([currentRevision, ...sortedRevisions]);
  const dedupedRevisions: DocumentRevision[] = [];
  const seenRevisionIds = new Set<string>();

  for (const revision of revisionsWithCurrent) {
    if (seenRevisionIds.has(revision.id)) continue;
    seenRevisionIds.add(revision.id);
    dedupedRevisions.push(revision);
  }

  return {
    currentRevision,
    revisions: dedupedRevisions,
  };
}
