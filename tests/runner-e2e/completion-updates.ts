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
  renderedLinks?: Array<{ commentId: string; href: string }>;
};
export const completionReviewRubric = [
  "Does the final source-thread answer accurately say the requested work is finished?",
  "Does it describe the saved result rather than repeat an earlier handoff promise?",
  "Can the user access that result without asking another question?",
  "Does it avoid inventing verification, publication, or other work not in the evidence?",
] as const;

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
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  // Delivery remains valid if a subsequent clarification omits the same link.
  // Keep the latest reply separately for semantic review of the whole exchange.
  const deliveries = responses.map(response => {
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
