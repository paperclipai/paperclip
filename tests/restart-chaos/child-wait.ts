import type { TaskRecord, TaskSample } from "./types.js";
import type { WakeEvidenceFile } from "./staging-mix-retry.js";

const ACTIVE = new Set(["queued", "running", "scheduled_retry"]);
const WAITING_DISPOSITIONS = new Set(["yielded", "blocked"]);
const CHILDREN_COMPLETED = "issue_children_completed";

function childWaitWindows(evidence: WakeEvidenceFile): Array<{ from: number; until: number }> {
  const completions = (evidence.wakes ?? []).filter(wake => wake.reason === CHILDREN_COMPLETED && typeof wake.createdAt === "number")
    .map(wake => wake.createdAt!).sort((a, b) => a - b);
  return (evidence.runs ?? []).flatMap(run => {
    if (!WAITING_DISPOSITIONS.has(run.acceptedDisposition ?? "") || typeof run.finishedAt !== "number") return [];
    const until = completions.find(at => at >= run.finishedAt!);
    return until === undefined ? [] : [{ from: run.finishedAt, until }];
  });
}

function idle(sample: TaskSample): boolean {
  return sample.reachable && !["done", "cancelled"].includes(sample.issueStatus ?? "") && !(sample.runs ?? []).some(run => ACTIVE.has(run.status));
}

export function withChildWaits(record: TaskRecord, evidence: WakeEvidenceFile | null): TaskRecord {
  if (!evidence) return record;
  const windows = childWaitWindows(evidence);
  if (!windows.length) return record;
  const waiting = (sample: TaskSample) => idle(sample) && windows.some(window => sample.at >= window.from && sample.at <= window.until);
  const samples = record.samples.map(sample => waiting(sample) ? { ...sample, waitingOnChildren: true } : sample);
  const last = [...samples].reverse().find(sample => sample.reachable);
  const wakes = new Map((evidence.wakes ?? []).map(wake => [wake.id, wake]));
  const finisher = (evidence.runs ?? []).find(run => run.acceptedDisposition === "done" && run.wakeupRequestId
    && wakes.get(run.wakeupRequestId)?.reason === CHILDREN_COMPLETED);
  const completedAt = evidence.completedAt ?? null;
  const restedWaiting = record.finalStatus !== "done" && record.restAt !== null && last?.waitingOnChildren === true;
  if (restedWaiting && finisher && completedAt !== null && completedAt > record.restAt!) {
    return { ...record, samples, finalStatus: "done", restAt: completedAt };
  }
  return { ...record, samples };
}
