import { createHash } from "node:crypto";
import type { AgentCommentaryDetail, AgentCommentaryPage } from "../../packages/shared/src/validators/agent-commentary.js";
import type { RunnerApi } from "./api.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
export type FeedbackCollectionStatus = "complete" | "partial" | "unavailable" | "not_started";
export interface FeedbackSummary {
  version: 1;
  collection: FeedbackCollectionStatus;
  invocationCollection: FeedbackCollectionStatus;
  toolAvailability: "observed" | "unknown";
  complaints: number;
  suggestions: number;
  bodiesCollected: number;
  runsInspected: number;
  invocations: { completed: number; failed: number; unknown: number };
  review: Array<{ fingerprint: string; kind: "complaint" | "suggestion"; occurrences: number; disposition: "needs_investigation" }>;
}
interface FeedbackInvocation {
  runId: string;
  callId: string;
  kind: "complaint" | "suggestion";
  outcome: "completed" | "failed" | "unknown";
}
export interface FeedbackEvidence {
  version: 1;
  companyId: string;
  entries: AgentCommentaryDetail[];
  invocations: FeedbackInvocation[];
  diagnostics: Array<"feedback_read_failed" | "feedback_detail_failed" | "feedback_pagination_incomplete" | "run_read_failed" | "run_detail_failed" | "run_limit_reached" | "events_read_failed" | "deadline_reached" | "evidence_limit_reached">;
  summary: FeedbackSummary;
}

export const FEEDBACK_COLLECTION_LIMITS = {
  entries: 1000, retainedBytes: 8 * 1024 * 1024, eventBytes: 16 * 1024 * 1024, events: 10_000,
} as const;

export function emptyFeedbackSummary(): FeedbackSummary {
  return { version: 1, collection: "not_started", invocationCollection: "not_started", toolAvailability: "unknown",
    complaints: 0, suggestions: 0, bodiesCollected: 0, runsInspected: 0,
    invocations: { completed: 0, failed: 0, unknown: 0 }, review: [] };
}

function feedbackKind(name: unknown): FeedbackInvocation["kind"] | undefined {
  if (typeof name !== "string") return undefined;
  const canonicalName = name.replace(/^(?:mcp__paperclip__|paperclip__|paperclip_)/, "");
  if (/(?:^|[.\/])submit_complaint$/.test(canonicalName)) return "complaint";
  if (/(?:^|[.\/])submit_suggestion$/.test(canonicalName)) return "suggestion";
  return undefined;
}

export function observeFeedbackInvocations(runId: string, events: readonly Row[]): FeedbackInvocation[] {
  const calls = new Map<string, FeedbackInvocation>();
  for (const event of events) {
    const envelope = row(row(event.payload).prpEvent);
    if (envelope.runId !== runId || envelope.sourceKind !== "runner" || envelope.eventType !== event.eventType) continue;
    const payload = row(envelope.payload), item = row(payload.item);
    const execution = typeof event.eventType === "string" && event.eventType.startsWith("tool.execution.");
    const callId = execution ? payload.executionId : item.id;
    if (typeof callId !== "string" || !callId) continue;
    const kind = feedbackKind(execution ? payload.name : item.name);
    const started = event.eventType === "tool.execution.started" || event.eventType === "item.started" && (payload.kind === "tool_call" || item.type === "tool_call");
    const completed = event.eventType === "tool.execution.completed" || event.eventType === "item.completed" && (payload.kind === "tool_result" || item.type === "tool_result");
    if ((execution || started || completed) && kind) calls.set(callId, calls.get(callId) ?? { runId, callId, kind, outcome: "unknown" });
    const call = calls.get(callId);
    if (!completed || !call || kind && kind !== call.kind) continue;
    const status = execution ? payload.status : item.status;
    if (payload.isError === true || item.isError === true || ["failed", "error", "cancelled"].includes(String(status))) call.outcome = "failed";
    else if (status === "completed") call.outcome = "completed";
  }
  return [...calls.values()];
}

export function feedbackReview(entries: readonly AgentCommentaryDetail[]): FeedbackSummary["review"] {
  const groups = new Map<string, FeedbackSummary["review"][number]>();
  for (const entry of entries) {
    const fingerprint = createHash("sha256").update(`${entry.kind}\n${entry.body.trim().replace(/\s+/g, " ")}`).digest("hex");
    const group = groups.get(fingerprint);
    if (group) group.occurrences++;
    else groups.set(fingerprint, { fingerprint, kind: entry.kind, occurrences: 1, disposition: "needs_investigation" });
  }
  return [...groups.values()];
}

export function summarizeCampaignFeedback(attempts: readonly { feedback?: FeedbackSummary }[]) {
  const review = new Map<string, FeedbackSummary["review"][number]>();
  let complaints = 0, suggestions = 0, incomplete = 0, failedSubmissions = 0, unknownSubmissions = 0;
  for (const { feedback } of attempts) {
    if (!feedback || feedback.collection !== "complete" || feedback.invocationCollection !== "complete") incomplete++;
    if (!feedback) continue;
    complaints += feedback.complaints;
    suggestions += feedback.suggestions;
    failedSubmissions += feedback.invocations.failed;
    unknownSubmissions += feedback.invocations.unknown;
    for (const group of feedback.review) {
      const previous = review.get(group.fingerprint);
      if (previous) previous.occurrences += group.occurrences;
      else review.set(group.fingerprint, { ...group });
    }
  }
  return { complaints, suggestions, incomplete, failedSubmissions, unknownSubmissions, review: [...review.values()] };
}

export async function collectAttemptFeedback(input: {
  api: Pick<RunnerApi, "get">;
  companyId: string;
  persist: (evidence: FeedbackEvidence, signal: AbortSignal) => Promise<void>;
  onCheckpoint?: (summary: FeedbackSummary) => void;
  deadlineAt?: number;
}): Promise<FeedbackSummary> {
  const deadlineAt = input.deadlineAt ?? Date.now() + 30_000;
  const readDeadlineAt = deadlineAt - Math.min(5_000, Math.max(0, Math.floor((deadlineAt - Date.now()) / 5)));
  const summary = emptyFeedbackSummary();
  let checkpointSummary = emptyFeedbackSummary();
  const retainedSummary = () => ({ ...structuredClone(checkpointSummary),
    ...(summary.collection !== "complete" ? { collection: summary.collection } : {}),
    ...(summary.invocationCollection !== "complete" ? { invocationCollection: summary.invocationCollection } : {}),
  });
  const evidence: FeedbackEvidence = { version: 1, companyId: input.companyId, entries: [], invocations: [], diagnostics: [], summary };
  let retainedBytes = 0, checkpointBytes = 0, eventBytes = 0, eventCount = 0;
  const diagnose = (code: FeedbackEvidence["diagnostics"][number]) => { if (!evidence.diagnostics.includes(code)) evidence.diagnostics.push(code); };
  const get = <T>(url: string) => {
    const remaining = readDeadlineAt - Date.now();
    if (remaining <= 0) { diagnose("deadline_reached"); throw new Error("Feedback collection deadline reached"); }
    return input.api.get<T>(url, { timeout: Math.min(5_000, remaining) });
  };
  const persist = async (force = false) => {
    summary.bodiesCollected = evidence.entries.length;
    summary.invocations = { completed: 0, failed: 0, unknown: 0 };
    for (const invocation of evidence.invocations) summary.invocations[invocation.outcome]++;
    summary.toolAvailability = evidence.invocations.length ? "observed" : "unknown";
    if (Date.now() >= deadlineAt) { diagnose("deadline_reached"); return false; }
    if (!force && (!retainedBytes || checkpointBytes > 0 && retainedBytes < Math.max(1024 * 1024, checkpointBytes * 2))) return true;
    summary.review = feedbackReview(evidence.entries);
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) { diagnose("deadline_reached"); return false; }
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
          abort.abort(); reject(new Error("Feedback persistence deadline reached"));
        }, remaining); }),
        input.persist(evidence, abort.signal),
      ]);
      if (Date.now() >= deadlineAt) { abort.abort(); diagnose("deadline_reached"); return false; }
      checkpointBytes = retainedBytes;
      checkpointSummary = structuredClone(summary);
      input.onCheckpoint?.(structuredClone(checkpointSummary));
    } finally { clearTimeout(timer); }
    return true;
  };
  if (!await persist(true)) {
    summary.collection = "unavailable";
    summary.invocationCollection = "unavailable";
    return summary;
  }
  const seen = new Set<string>();
  let expectedTotal: number | undefined;
  let detailsFailed = false;
  feedbackPages: for (let offset = 0; offset < FEEDBACK_COLLECTION_LIMITS.entries; offset += 100) {
    let page: AgentCommentaryPage;
    try {
      page = await get<AgentCommentaryPage>(`/api/companies/${input.companyId}/agent-commentary?limit=100&offset=${offset}`);
      if (!Array.isArray(page.items) || !Number.isSafeInteger(page.total) || page.total < 0 || page.items.length > 100) throw new Error("Invalid feedback page");
    } catch {
      summary.collection = seen.size ? "partial" : "unavailable";
      diagnose("feedback_read_failed");
      break;
    }
    expectedTotal ??= page.total;
    summary.collection = "partial";
    for (const entry of page.items) {
      if (Date.now() >= readDeadlineAt) { diagnose("deadline_reached"); break feedbackPages; }
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      if (entry.kind === "complaint") summary.complaints++;
      else if (entry.kind === "suggestion") summary.suggestions++;
      else { detailsFailed = true; continue; }
      try {
        const detail = await get<AgentCommentaryDetail>(`/api/companies/${input.companyId}/agent-commentary/${encodeURIComponent(entry.id)}`);
        if (detail.id !== entry.id || detail.kind !== entry.kind || detail.runId !== entry.runId || typeof detail.body !== "string") throw new Error("Invalid feedback detail");
        const bytes = Buffer.byteLength(JSON.stringify(detail)) + 1;
        if (retainedBytes + bytes + 4 > FEEDBACK_COLLECTION_LIMITS.retainedBytes) { diagnose("evidence_limit_reached"); break feedbackPages; }
        evidence.entries.push(detail);
        retainedBytes += bytes;
      } catch {
        detailsFailed = true;
        diagnose("feedback_detail_failed");
      }
      if (evidence.entries.length % 10 === 0 && !await persist()) break feedbackPages;
    }
    if (!await persist()) break;
    if (offset + page.items.length >= page.total || page.items.length < 100) {
      if (seen.size === page.total && expectedTotal === page.total && !detailsFailed) summary.collection = "complete";
      else diagnose("feedback_pagination_incomplete");
      break;
    }
    if (offset + 100 >= FEEDBACK_COLLECTION_LIMITS.entries) diagnose("evidence_limit_reached");
  }
  if (!await persist(true)) summary.collection = evidence.entries.length ? "partial" : "unavailable";
  let runs: Array<{ id: string; status?: string }>;
  try {
    runs = await get(`/api/companies/${input.companyId}/heartbeat-runs?limit=1000`);
    if (!Array.isArray(runs) || runs.length > 1000 || runs.some(run => typeof run.id !== "string")) throw new Error("Invalid runs");
  } catch {
    summary.invocationCollection = "unavailable";
    diagnose("run_read_failed");
    await persist(true);
    return retainedSummary();
  }
  summary.invocationCollection = runs.length < 1000 ? "complete" : "partial";
  if (runs.length >= 1000) diagnose("run_limit_reached");
  for (const listed of runs) {
    let run: { id: string; status?: string; runtimeMode?: string } = listed;
    try {
      const detail = await get<typeof run>(`/api/heartbeat-runs/${encodeURIComponent(listed.id)}`);
      if (detail.id !== listed.id) throw new Error("Invalid run detail");
      run = detail;
    } catch {
      summary.invocationCollection = "partial";
      summary.collection = summary.collection === "complete" ? "partial" : summary.collection;
      diagnose("run_detail_failed");
    }
    if (!["succeeded", "interrupted", "failed", "cancelled", "timed_out"].includes(run.status ?? "")) {
      summary.collection = summary.collection === "complete" ? "partial" : summary.collection;
      summary.invocationCollection = "partial";
    }
    if (run.runtimeMode !== "native") summary.invocationCollection = "partial";
    const events: Row[] = [];
    let afterSeq = 0;
    try {
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const page = await get<Row[]>(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=100`);
        if (!Array.isArray(page) || page.length > 100) throw new Error("Invalid events");
        for (const event of page) {
          if (!Number.isSafeInteger(event.seq) || Number(event.seq) <= afterSeq) throw new Error("Invalid event sequence");
          const bytes = Buffer.byteLength(JSON.stringify(event));
          if (eventCount >= FEEDBACK_COLLECTION_LIMITS.events || eventBytes + bytes > FEEDBACK_COLLECTION_LIMITS.eventBytes) {
            diagnose("evidence_limit_reached"); throw new Error("Feedback event limit reached");
          }
          eventCount++; eventBytes += bytes;
          afterSeq = Number(event.seq);
          events.push(event);
        }
        if (page.length < 100) break;
        if (pageNumber === 99) { diagnose("evidence_limit_reached"); throw new Error("Event limit reached"); }
      }
      summary.runsInspected++;
    } catch {
      summary.invocationCollection = "partial";
      diagnose("events_read_failed");
    }
    for (const invocation of observeFeedbackInvocations(run.id, events)) {
      const bytes = Buffer.byteLength(JSON.stringify(invocation)) + 1;
      if (retainedBytes + bytes + 4 > FEEDBACK_COLLECTION_LIMITS.retainedBytes) { diagnose("evidence_limit_reached"); break; }
      retainedBytes += bytes;
      evidence.invocations.push(invocation);
    }
    if (!await persist() || evidence.diagnostics.includes("evidence_limit_reached")) {
      summary.invocationCollection = "partial";
      break;
    }
  }
  if (!await persist(true)) summary.invocationCollection = "partial";
  return retainedSummary();
}
