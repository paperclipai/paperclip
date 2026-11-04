/** A separately authenticated human fixture. Credentials remain with its target provider. */
export interface InboxAuthorFixture {
  userId: string;
  postComment(input: { issueId: string; body: string }): Promise<InboxAuthorComment>;
}
export interface InboxAuthorComment {
  id: string;
  companyId: string;
  issueId: string;
  body: string;
  authorUserId: string | null;
  authorAgentId: string | null;
  createdByRunId?: string | null;
}

/** Neither an owner-authored comment nor claimed alternate attribution proves unread activity. */
export function inboxAuthorCommentMatches(value: InboxAuthorComment | null | undefined, expected: {
  companyId: string; issueId: string; ownerUserId: string; authorUserId: string; body: string;
}) {
  return Boolean(value && typeof value.id === "string" && value.id
    && expected.authorUserId && expected.authorUserId !== expected.ownerUserId && expected.body
    && value.companyId === expected.companyId && value.issueId === expected.issueId && value.body === expected.body
    && value.authorUserId === expected.authorUserId && value.authorAgentId === null && value.createdByRunId == null);
}
