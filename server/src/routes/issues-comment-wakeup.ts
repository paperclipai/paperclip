type CommentWakeConfig = {
  reason: string;
  source: string;
  wakeReason: string;
};

export function commentWakeConfig(actorIsAgent: boolean): CommentWakeConfig {
  if (actorIsAgent) {
    return {
      reason: "issue_commented",
      source: "issue.comment",
      wakeReason: "issue_commented",
    };
  }
  return {
    reason: "issue_comment_board",
    source: "issue.comment.board",
    wakeReason: "issue_comment_board",
  };
}
