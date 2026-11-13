type Json = Record<string, unknown>;

export interface DeliveryRun {
  runId: string | null;
  createdAt: number | null;
  startedAt?: number | null;
  wakeupRequestId: string | null;
  contextSnapshot?: unknown;
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

export function laterAnswers(evidence: { runs?: readonly DeliveryRun[]; wakes?: readonly DeliveryWake[] } | null): Map<string, LaterAnswer> {
  const answers = new Map<string, LaterAnswer>();
  if (!evidence) return answers;
  const wakes = new Map((evidence.wakes ?? []).map(wake => [wake.id, wake]));
  const started = (evidence.runs ?? []).filter((run): run is DeliveryRun & { runId: string; startedAt: number } => Boolean(run.runId) && typeof run.startedAt === "number")
    .sort((a, b) => a.startedAt - b.startedAt);
  const firstStart = started[0]?.startedAt ?? null;
  started.forEach((run, index) => {
    const wake = run.wakeupRequestId ? wakes.get(run.wakeupRequestId) : undefined;
    const owed = wakeInputCommentIds(run, wake);
    const postedAt = typeof wake?.createdAt === "number" ? wake.createdAt : null;
    const postedDuringWork = postedAt !== null && firstStart !== null ? postedAt >= firstStart : index > 0;
    if (index > 0 && postedDuringWork && owed.length) {
      answers.set(run.runId, { runId: run.runId, commentIds: owed, postedAt, queuedAt: run.createdAt, startedAt: run.startedAt });
    }
  });
  return answers;
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
