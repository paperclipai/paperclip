import type {
  IssueComment,
  IssueQueuedCommentQueue,
  IssueQueuedCommentQueueState,
  IssueQueuedCommentSteeringDisposition,
} from "@paperclipai/shared";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const STEERING_DISPOSITIONS = new Set<IssueQueuedCommentSteeringDisposition>([
  "available",
  "unsupported",
  "temporarily_unavailable",
]);
const QUEUE_STATES = new Set<IssueQueuedCommentQueueState>(["deferred", "queued"]);

/** Defensive boundary shared by IssueDetail and Storybook queue fixtures. */
export function normalizeIssueQueuedCommentQueue(
  value: unknown,
  fallbackIssueId: string,
): IssueQueuedCommentQueue {
  const source = record(value);
  const seen = new Set<string>();
  const entries = (Array.isArray(source?.entries) ? source.entries : [])
    .flatMap((candidate, sourcePosition) => {
      const entry = record(candidate);
      const comment = record(entry?.comment);
      const id = typeof comment?.id === "string" ? comment.id : "";
      const body = typeof comment?.body === "string" ? comment.body : null;
      if (!id || body === null || seen.has(id)) return [];
      seen.add(id);
      const position = typeof entry?.position === "number" && Number.isFinite(entry.position)
        ? entry.position
        : sourcePosition;
      return [{
        comment: comment as unknown as IssueComment,
        position,
        canEdit: entry?.canEdit === true,
        canDiscard: entry?.canDiscard === true,
      }];
    })
    .sort((left, right) => left.position - right.position)
    .map((entry, position) => ({ ...entry, position }));
  const disposition = source?.steeringDisposition;
  const state = source?.state;

  return {
    issueId: typeof source?.issueId === "string" ? source.issueId : fallbackIssueId,
    queueId: typeof source?.queueId === "string" ? source.queueId : null,
    state:
      typeof state === "string" && QUEUE_STATES.has(state as IssueQueuedCommentQueueState)
        ? state as IssueQueuedCommentQueueState
        : null,
    targetRunId: typeof source?.targetRunId === "string" ? source.targetRunId : null,
    revision: typeof source?.revision === "string" ? source.revision : "unavailable",
    protocol: source?.protocol === "paperclip_runner_v1" ? "paperclip_runner_v1" : "legacy",
    steeringDisposition:
      typeof disposition === "string"
      && STEERING_DISPOSITIONS.has(disposition as IssueQueuedCommentSteeringDisposition)
        ? disposition as IssueQueuedCommentSteeringDisposition
        : "unsupported",
    entries,
  };
}
