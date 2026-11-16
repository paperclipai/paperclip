import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChaosApi } from "./api.js";
import { replayCommand } from "./config.js";
import type { TimelineEntry } from "./timeline.js";
import type { FaultReceipt, OracleArtifacts, TaskGrade, TaskRecord, WavePlan } from "./types.js";

export { captureWakeEvidence, wakeEvidenceOnce } from "./wake-evidence.js";

const LOG_BEFORE_BYTES = 128 * 1024;
const LOG_AFTER_BYTES = 512 * 1024;
export const EVENTS_HEAD = 400;
export const EVENTS_TAIL = 200;
const OBSERVER_POLL_LINE = /INFO\S*: \S*(?:GET|HEAD) \/(?:issues\/[0-9a-f-]+(?:\/runs)?|ready|liveness|health) 200/;

type Json = Record<string, any>;

/** Canary (soak U7): never let a provider key reach an evidence file. */
export function redactKnownSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const value of secrets) if (value.length >= 8) out = out.split(value).join("[REDACTED]");
  return out;
}

export function knownSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  // Any *KEY, *TOKEN, *SECRET or *PASSWORD name, including PAPERCLIP_AGENT_PRIVATE_KEY and AWS_SECRET_ACCESS_KEY.
  return Object.entries(env).filter(([key, value]) => value && /(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(key)).map(([, value]) => value!);
}

export async function runEvents(api: ChaosApi, runId: string): Promise<Json[]> {
  const head: Json[] = [], tail: Json[] = [];
  let total = 0, afterSeq = 0, omittedFrom: unknown = null, omittedTo: unknown = null;
  for (let page = 0; page < 200; page += 1) {
    const rows = await api.get<Json[]>(`/api/heartbeat-runs/${runId}/events?afterSeq=${afterSeq}&limit=500`);
    if (!rows?.length) break;
    for (const row of rows) {
      total += 1;
      if (head.length < EVENTS_HEAD) { head.push(row); continue; }
      tail.push(row);
      if (tail.length > EVENTS_TAIL) { const dropped = tail.shift()!; omittedFrom ??= dropped.seq ?? null; omittedTo = dropped.seq ?? null; }
    }
    const next = Number(rows[rows.length - 1]?.seq);
    if (!Number.isFinite(next) || next <= afterSeq || rows.length < 500) break;
    afterSeq = next;
  }
  const omitted = total - head.length - tail.length;
  return omitted > 0 ? [...head, { omittedEvents: omitted, fromSeq: omittedFrom, toSeq: omittedTo }, ...tail] : [...head, ...tail];
}

async function logWindow(serverLogPath: string, faults: readonly FaultReceipt[]): Promise<string> {
  if (!faults.length) return "";
  const handle = await open(serverLogPath, "r").catch(() => null);
  if (!handle) return "";
  try {
    const size = (await handle.stat()).size;
    const parts: string[] = [];
    for (const fault of faults) {
      const start = Math.max(0, fault.serverLogOffsetAtStart - LOG_BEFORE_BYTES);
      const end = Math.min(size, (fault.serverLogOffsetAtReady ?? fault.serverLogOffsetAtStart) + LOG_AFTER_BYTES);
      const buffer = Buffer.alloc(Math.max(0, end - start));
      await handle.read(buffer, 0, buffer.length, start);
      // Drop the observer's own polling request lines; they bury the recovery log.
      const text = buffer.toString("utf8").split("\n").filter(line => !OBSERVER_POLL_LINE.test(line)).join("\n");
      parts.push(`===== ${fault.faultId} ${fault.kind} bytes ${start}-${end} (observer GET lines removed) =====\n${text}`);
    }
    return parts.join("\n");
  } finally { await handle.close(); }
}

/** Bundle everything a fix-failed-paperclip-run session needs to start (plan §5.7). */
export async function writeEvidenceBundle(input: {
  directory: string; api: ChaosApi; plan: WavePlan; record: TaskRecord; grade: TaskGrade; artifacts: OracleArtifacts | null;
  faults: readonly FaultReceipt[]; timeline: readonly TimelineEntry[]; serverLogPath: string; gitSha: string; gitDirty: boolean;
  issue: Json | null; secrets: readonly string[];
}): Promise<string> {
  const { directory, api, record } = input;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const write = (name: string, value: unknown) => writeFile(path.join(directory, name),
    redactKnownSecrets(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, input.secrets), { mode: 0o600 });
  const errors: string[] = [];
  const attempt = async (label: string, work: () => Promise<void>) => {
    try { await work(); } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  };
  const relevant = input.faults.filter(fault => input.grade.crossingFaults.includes(fault.faultId) || record.faultIds.includes(fault.faultId));
  await write("meta.json", {
    schema: "paperclip.restart-chaos.evidence/v1", waveId: input.plan.waveId, seed: input.plan.seed, taskId: record.plan.taskId,
    gitSha: input.gitSha, gitDirty: input.gitDirty, signature: input.grade.signature, replay: replayCommand(input.plan.waveId, record.plan.taskId),
    issueId: record.issueId, identifier: record.identifier, task: record.plan, options: input.plan.options,
  });
  await write("grade.json", input.grade);
  await write("task-record.json", record);
  await write("faults.json", relevant.length ? relevant : input.faults);
  await write("startup-phases.json", (relevant.length ? relevant : input.faults).map(fault => ({ faultId: fault.faultId, kind: fault.kind,
    startedAt: fault.startedAt, stoppedAt: fault.stoppedAt, restartedAt: fault.restartedAt, healthyAt: fault.healthyAt, readyAt: fault.readyAt, phases: fault.phases,
    ...(fault.repeatedRestart ? { repeatedRestarts: fault.repeatedRestart.restarts } : {}) })));
  await write("timeline.json", input.timeline);
  if (input.artifacts) await write("oracle-artifacts.json", input.artifacts);
  await attempt("server-log", async () => write("server-log-window.txt", await logWindow(input.serverLogPath, relevant.length ? relevant : input.faults)));
  if (record.issueId) {
    await attempt("issue", async () => write("issue.json", input.issue ?? await api.get(`/api/issues/${record.issueId}`)));
    let runs: Json[] = [];
    await attempt("runs", async () => { runs = await api.get<Json[]>(`/api/issues/${record.issueId}/runs`); await write("runs.json", runs); });
    for (const run of runs) {
      const runId = String(run.runId ?? run.id);
      await attempt(`events ${runId}`, async () => write(`run-${runId}-events.json`, await runEvents(api, runId)));
      await attempt(`workspace-operations ${runId}`, async () => write(`run-${runId}-workspace-operations.json`,
        await api.get(`/api/heartbeat-runs/${runId}/workspace-operations`)));
    }
    await attempt("comments", async () => write("comments.json", await api.get(`/api/issues/${record.issueId}/comments`)));
  }
  if (errors.length) await write("collection-errors.json", errors);
  return directory;
}
