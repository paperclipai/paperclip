/** A missing/invalid write receipt is not proof that the comment was rejected.
 * Kept separate from API clients so the composers can recognize this outcome
 * without coupling their state machine to a mocked or alternate client. */
export class CommentSubmissionUnknownError extends Error {
  constructor() {
    super(
      "We couldn’t confirm whether this comment was saved. Review the conversation before starting another draft.",
    );
    this.name = "CommentSubmissionUnknownError";
  }
}
