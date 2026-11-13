/** Mechanical delivery/access evidence, not a prose-quality or truthfulness judge.
 * Keep replies verbatim for semantic review; never accept a marker alone as output.
 */
type Row = Record<string, any>;
export type CompletionObservation = {
  sourceId: string;
  worker: Row;
  documents: Row[];
  comments: Row[];
  runs: Row[];
  marker: string;
  /** Synthetic user request and released brief, never inferred from the reply. */
  fixtureRequest?: string;
  /** Only other tasks explicitly delegated by this isolated fixture. */
  relatedTasks?: Array<{ task: Row; documents: Row[] }>;
  renderedLinks?: Array<{ commentId: string; href: string }>;
};
export const completionReviewRubric = [
  "Does the final source-thread answer accurately say the requested work is finished?",
  "Does it describe the saved result rather than repeat an earlier handoff promise?",
  "Can the user access that result without asking another question?",
  "Does it avoid inventing verification, publication, or other work not in the evidence?",
  "Does it avoid repeated completion announcements or redundant acknowledgements, while allowing corrections and updates about different tasks?",
] as const;

export const COMPLETION_RESTART_GATE_SKIPPED = "restart boundary not reached (agent skipped gate)";

type GateState = { sourceId: string; workerId: string; ready: string; runs: Row[]; comments: Row[] };
const completionTurns = (state: GateState) => state.runs.filter(r => r.contextSnapshot?.issueId === state.sourceId &&
  r.contextSnapshot?.wakeReason === "chat_task_completed");
/** Correlated as completionDelivery does: the turn received this task's Done facts. */
const carriesWorker = (run: Row, workerId: string) => Array.isArray(run.contextSnapshot?.chatCompletionUpdates) &&
  run.contextSnapshot.chatCompletionUpdates.some((u: Row) => u.id === workerId);

/**
 * The restart cell's boundary is the source provider waiting at its reference
 * gate. The completion reply is published inside the run finalizer's own
 * transaction, which an isolated-server fixture cannot hold without a product
 * hook, so reaching the boundary depends on the agent running the wait. Once
 * no completion turn is active and this task's correlated turn has succeeded
 * or published its reply without the gate ever reporting "waiting", the
 * boundary can no longer be reached: report it by name instead of waiting for
 * a generic timeout. A failed or cancelled turn is not evidence that the agent
 * skipped the gate, and delivery may retry it; completionRestartGateTimeoutDetail
 * names it if the wait then times out.
 */
export function completionRestartGateSkipped(state: GateState): string | undefined {
  if (state.ready === "waiting") return undefined;
  const turns = completionTurns(state);
  if (turns.some(r => ["queued", "running"].includes(String(r.status)))) return undefined;
  const correlated = turns.filter(r => carriesWorker(r, state.workerId));
  const reply = state.comments.find(c => c.authorAgentId && correlated.some(r => r.id === c.createdByRunId));
  if (reply) return `${COMPLETION_RESTART_GATE_SKIPPED}: agent reply ${reply.id} was published without the reference gate reporting waiting`;
  const succeeded = correlated.find(r => r.status === "succeeded");
  if (succeeded) return `${COMPLETION_RESTART_GATE_SKIPPED}: completion turn ${succeeded.id} ended succeeded without the reference gate reporting waiting`;
  return undefined;
}

/** Names completion turns that ended unsuccessfully before the gate when the wait times out. */
export function completionRestartGateTimeoutDetail(state: GateState | undefined): string | undefined {
  if (!state || state.ready === "waiting") return undefined;
  const ended = completionTurns(state).filter(r => !["queued", "running", "succeeded"].includes(String(r.status)));
  if (!ended.length) return undefined;
  return `restart boundary not reached: completion turn(s) ${ended.map(r => `${r.id} ended ${r.status}`).join(", ")} before the reference gate reported waiting`;
}

/** The start time exists only in the brief released after the source is idle. */
export function completionOutputUsesReleasedBrief(body: string): boolean {
  return /\b(?:10\s*[:.h]\s*30|ten[-\s]+thirty|half[\s-]+past[\s-]+(?:ten|10))\b/i.test(body);
}

export function completionDelivery(observation: CompletionObservation) {
  const { worker, documents, comments, runs, sourceId, marker } = observation;
  const completedAt = Date.parse(worker.completedAt);
  const outputs = documents.filter(d => d.issueId === worker.id &&
    !new Set(["plan", "summary", "proposal"]).has(String(d.key ?? "").toLowerCase()) && typeof d.body === "string" && d.body.includes(marker));
  const responses = comments.filter(c => c.issueId === sourceId && c.authorAgentId &&
    Number.isFinite(completedAt) && Date.parse(c.createdAt) >= completedAt &&
    runs.some(r => r.id === c.createdByRunId && r.agentId === c.authorAgentId &&
      r.contextSnapshot?.issueId === sourceId && r.status === "succeeded"));
  responses.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const latestResponse = responses.at(-1);
  const correlated = responses.filter(c => runs.some(r => r.id === c.createdByRunId &&
    Array.isArray(r.contextSnapshot?.chatCompletionUpdates) &&
    r.contextSnapshot.chatCompletionUpdates.some((update: Row) => update.id === worker.id && update.status === "done")));
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  // Delivery remains valid if a subsequent clarification omits the same link.
  // Keep the latest reply separately for semantic review of the whole exchange.
  const deliveries = correlated.map(response => {
    const body = String(response.body ?? "");
    const links = (observation.renderedLinks ?? []).filter(link => link.commentId === response.id).map(link => link.href);
    const resultLinks = links.filter(link => {
      try {
        const url = new URL(link, "http://fixture.invalid");
        const parts = url.pathname.split("/").map(decodeURIComponent);
        const index = parts.indexOf("issues");
        return index >= 0 && [worker.id, worker.identifier].filter(Boolean).includes(parts[index + 1]);
      } catch { return false; }
    });
    const quotedOutput = outputs.some(d => normalize(d.body).length >= 60 && normalize(body).includes(normalize(d.body)));
    return { response, resultLinks, quotedOutput };
  });
  const delivered = deliveries.filter(d => d.resultLinks.length > 0 || d.quotedOutput).at(-1);
  const final = delivered?.response ?? latestResponse;
  const resultLinks = delivered?.resultLinks ?? [];
  const quotedOutput = delivered?.quotedOutput ?? false;
  return {
    checks: [
      { id: "completion-worker-done", passed: worker.status === "done" && Number.isFinite(completedAt), detail: "The delegated task is durably Done, not merely a successful run" },
      { id: "completion-output-saved", passed: outputs.length > 0, detail: "The worker saved a non-plan deliverable containing the requested reference" },
      { id: "completion-source-response", passed: Boolean(final), detail: "The originating thread has a run-attributed agent reply after task completion" },
      { id: "completion-source-correlated", passed: correlated.length > 0, detail: "A reply run received authoritative completion facts for this task; a late initial handoff reply does not qualify" },
      { id: "completion-result-access", passed: Boolean(final) && (resultLinks.length > 0 || quotedOutput), detail: "That reply links to the completed task/output or includes the actual saved output" },
    ],
    response: final ?? null,
    latestResponse: latestResponse ?? null,
    responses,
    resultLinks,
    quotedOutput,
    semanticReview: { status: "required", rubric: completionReviewRubric },
  };
}
