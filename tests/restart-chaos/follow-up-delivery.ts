type Json = Record<string, unknown>;

export interface DeliveryRun {
  runId: string | null;
  createdAt: number | null;
  startedAt?: number | null;
  wakeupRequestId: string | null;
  contextSnapshot?: unknown;
  providerTurnStarted?: boolean | null;
}

export interface DeliveryWake { id: string | null; createdAt?: number | null; payload?: unknown }

export interface LaterAnswer {
  runId: string;
  commentIds: string[];
  postedAt: number | null;
  queuedAt: number | null;
  startedAt: number;
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string")
  : typeof value === "string" ? [value] : [];
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

export function wakeInputCommentIds(run: Pick<DeliveryRun, "contextSnapshot">, wake: DeliveryWake | undefined): string[] {
  const context = object(run.contextSnapshot);
  const payload = object(wake?.payload);
  const wakeContext = object(payload._paperclipWakeContext);
  return [...new Set([...strings(context.wakeCommentIds), ...strings(context.wakeCommentId), ...strings(object(context.paperclipWake).commentIds),
    ...strings(payload.commentId), ...strings(wakeContext.wakeCommentIds), ...strings(wakeContext.wakeCommentId)])];
}

const earliest = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.min(a, b);

type DeliveryEvidence = { runs?: readonly DeliveryRun[]; wakes?: readonly DeliveryWake[] } | null;

function followUpDeliveries(evidence: DeliveryEvidence): { answers: Map<string, LaterAnswer>; undelivered: Set<string> } {
  const answers = new Map<string, LaterAnswer>();
  const undelivered = new Set<string>();
  if (!evidence) return { answers, undelivered };
  const wakes = new Map((evidence.wakes ?? []).map(wake => [wake.id, wake]));
  const started = (evidence.runs ?? []).filter((run): run is DeliveryRun & { runId: string; startedAt: number } => Boolean(run.runId) && typeof run.startedAt === "number")
    .sort((a, b) => a.startedAt - b.startedAt);
  const firstStart = started[0]?.startedAt ?? null;
  let carried: { commentIds: string[]; postedAt: number | null } | null = null;
  started.forEach((run, index) => {
    const wake = run.wakeupRequestId ? wakes.get(run.wakeupRequestId) : undefined;
    const postedAt = typeof wake?.createdAt === "number" ? wake.createdAt : null;
    const postedDuringWork = postedAt !== null && firstStart !== null ? postedAt >= firstStart : index > 0;
    const owed = index > 0 && postedDuringWork ? wakeInputCommentIds(run, wake) : [];
    const commentIds = [...new Set([...(carried?.commentIds ?? []), ...owed])];
    if (!commentIds.length) return;
    const firstPostedAt = owed.length ? earliest(carried?.postedAt ?? null, postedAt) : carried?.postedAt ?? null;
    if (run.providerTurnStarted === false) {
      carried = { commentIds, postedAt: firstPostedAt };
      undelivered.add(run.runId);
      return;
    }
    carried = null;
    answers.set(run.runId, { runId: run.runId, commentIds, postedAt: firstPostedAt, queuedAt: run.createdAt, startedAt: run.startedAt });
  });
  return { answers, undelivered };
}

export function laterAnswers(evidence: DeliveryEvidence): Map<string, LaterAnswer> {
  return followUpDeliveries(evidence).answers;
}

export function undeliveredFollowUpRuns(evidence: DeliveryEvidence): Set<string> {
  return followUpDeliveries(evidence).undelivered;
}

export const COMPLETION_INCOMPLETE_KEY = "native-completion-incomplete";

export function rejectedDoneRuns(evidence: { runs?: ReadonlyArray<{ runId: string | null; acceptedDisposition?: string | null; acceptedAt?: number | null }>;
  wakes?: readonly DeliveryWake[] } | null): Set<string> {
  const rejected = new Set<string>();
  const results = (evidence?.runs ?? []).flatMap(run => run.runId && run.acceptedDisposition && typeof run.acceptedAt === "number"
    ? [{ runId: run.runId, disposition: run.acceptedDisposition, acceptedAt: run.acceptedAt }] : []);
  for (const wake of evidence?.wakes ?? []) {
    const at = wake.createdAt;
    if (typeof at !== "number" || object(wake.payload).continuationIdempotencyKey !== COMPLETION_INCOMPLETE_KEY) continue;
    const cause = results.filter(run => run.acceptedAt <= at).sort((a, b) => b.acceptedAt - a.acceptedAt)[0];
    if (cause?.disposition === "done") rejected.add(cause.runId);
  }
  return rejected;
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

export function laterAnswerWaits(answers: readonly LaterAnswer[]): { count: number; queueWaitP50Ms: number | null; queueWaitMaxMs: number | null;
  answerAfterPostP50Ms: number | null; answerAfterPostMaxMs: number | null } {
  const queued = answers.flatMap(answer => answer.queuedAt === null ? [] : [answer.startedAt - answer.queuedAt]);
  const posted = answers.flatMap(answer => answer.postedAt === null ? [] : [answer.startedAt - answer.postedAt]);
  return { count: answers.length, queueWaitP50Ms: percentile(queued, 0.5), queueWaitMaxMs: queued.length ? Math.max(...queued) : null,
    answerAfterPostP50Ms: percentile(posted, 0.5), answerAfterPostMaxMs: posted.length ? Math.max(...posted) : null };
}
