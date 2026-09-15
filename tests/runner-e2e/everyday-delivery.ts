export interface StoryDelivery {
  issueId: string;
  id: string;
  createdAt: string;
  originalFilename?: string;
  filename?: string;
  contentType?: string;
  sha256?: string;
}

/** A user can receive a delegated deliverable on the parent or the child. */
export function latestStoryDelivery(
  attachments: readonly StoryDelivery[],
  allowedIssueIds: readonly string[],
  after?: number,
  preservedContentHashes: readonly string[] = [],
): StoryDelivery | undefined {
  const allowed = new Set(allowedIssueIds);
  return attachments
    .filter(
      (a) =>
        allowed.has(a.issueId) &&
        (!a.sha256 || !preservedContentHashes.includes(a.sha256)) &&
        (/\.zip$/i.test(a.originalFilename ?? a.filename ?? "") ||
          a.contentType === "application/zip") &&
        Number.isFinite(Date.parse(a.createdAt)) &&
        (after === undefined || Date.parse(a.createdAt) >= after),
    )
    .sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.id.localeCompare(a.id),
    )[0];
}
