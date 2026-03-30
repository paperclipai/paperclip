export function restoreSubmittedCommentDraft(params: {
  currentBody: string;
  submittedBody: string;
}) {
  return params.currentBody.trim() ? params.currentBody : params.submittedBody;
}
