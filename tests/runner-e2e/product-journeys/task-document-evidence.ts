/** Saved-state checks. Browser actions must produce these records through the normal API. */
export interface TaskDocumentExpectation {
  companyId: string; issueId: string; userId: string; key: string; title: string; body: string;
}
export interface TaskDocumentSnapshot {
  id: string; companyId: string; issueId: string; key: string; title: string | null; body: string; format: string;
  latestRevisionId: string | null; latestRevisionNumber: number;
  createdByUserId: string | null; createdByAgentId: string | null;
  updatedByUserId: string | null; updatedByAgentId: string | null;
}
export interface TaskDocumentRevision {
  id: string; companyId: string; issueId: string; documentId: string; key: string;
  title: string | null; body: string; format: string; revisionNumber: number;
  createdByUserId: string | null; createdByAgentId: string | null; createdByRunId?: string | null;
}

export function taskDocumentMatches(document: TaskDocumentSnapshot | undefined, expected: TaskDocumentExpectation): boolean {
  return Boolean(document && document.id && document.latestRevisionId
    && Number.isSafeInteger(document.latestRevisionNumber) && document.latestRevisionNumber > 0
    && document.companyId === expected.companyId && document.issueId === expected.issueId
    && document.key === expected.key && document.format === "markdown"
    && document.title === expected.title && document.body === expected.body
    && document.createdByUserId === expected.userId && document.createdByAgentId === null
    && document.updatedByUserId === expected.userId && document.updatedByAgentId === null);
}

function revisionMatches(revision: TaskDocumentRevision | undefined, document: TaskDocumentSnapshot, expected: TaskDocumentExpectation): boolean {
  return Boolean(revision && revision.id === document.latestRevisionId
    && revision.revisionNumber === document.latestRevisionNumber && revision.documentId === document.id
    && revision.companyId === expected.companyId && revision.issueId === expected.issueId
    && revision.key === expected.key && revision.format === "markdown"
    && revision.title === expected.title && revision.body === expected.body
    && revision.createdByUserId === expected.userId && revision.createdByAgentId === null
    && revision.createdByRunId == null);
}

export function taskDocumentHistoryPasses(input: {
  initial: TaskDocumentSnapshot; current: TaskDocumentSnapshot;
  original: TaskDocumentExpectation; revised: TaskDocumentExpectation;
  revisions: TaskDocumentRevision[];
  originalRevision: TaskDocumentRevision; currentRevision: TaskDocumentRevision;
}): boolean {
  const { initial, current, original, revised, revisions } = input;
  return taskDocumentMatches(initial, original) && taskDocumentMatches(current, revised)
    && initial.id === current.id && initial.latestRevisionId !== current.latestRevisionId
    && current.latestRevisionNumber > initial.latestRevisionNumber
    && original.body !== revised.body && original.title !== revised.title
    && revisions.filter(revision => revision.id === initial.latestRevisionId).length === 1
    && revisions.filter(revision => revision.id === current.latestRevisionId).length === 1
    && revisionMatches(input.originalRevision, initial, original)
    && revisionMatches(input.currentRevision, current, revised)
    && revisionMatches(revisions.find(revision => revision.id === initial.latestRevisionId), initial, original)
    && revisionMatches(revisions.find(revision => revision.id === current.latestRevisionId), current, revised);
}
