import { pollUntil } from "./api.js";
import type { Row } from "./first-task-scoring.js";

/** The composer clears optimistically, before its user comment is persisted. */
export async function waitForFirstTaskReply(input: {
  load: () => Promise<Row[]>;
  previousIds: ReadonlySet<string>;
  message: string;
  deadlineAt: number;
}) {
  return pollUntil({
    label: "first-task user reply persisted",
    deadlineAt: input.deadlineAt,
    intervalMs: 100,
    load: input.load,
    accept: (comments) =>
      comments.some(
        (comment) =>
          !input.previousIds.has(comment.id) &&
          !comment.authorAgentId &&
          comment.body === input.message,
      ),
  });
}
