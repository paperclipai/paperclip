import type { ContextIntegrityCase } from "./context-integrity-cases.js";

export interface ContextIntegrityCheckpoint {
  phase: "initial" | "comment-1" | "comment-2" | "comment-3" | "final";
  issue: { id: string; status: string };
  comments: Array<Record<string, unknown>>;
  queuedComments?: Record<string, unknown>;
  documents: Array<{ key: string; body?: string | null }>;
  runs: Array<Record<string, unknown>>;
  assignedSkill?: { key: string; runtimeName?: string; versionId?: string | null; markdown?: string };
  skillRequestText?: string;
  runEvents?: Array<Record<string, unknown>>;
  runLogs?: unknown[];
  skillInvocationEvidence?: boolean;
}

function userComments(checkpoint: ContextIntegrityCheckpoint) {
  return checkpoint.comments
    .filter(
      (comment) =>
        !comment.createdByRunId &&
        (comment.authorType === "user" || comment.authorUserId),
    )
    .map((comment) => String(comment.body ?? ""));
}

function humanCommentRows(checkpoint: ContextIntegrityCheckpoint) {
  return checkpoint.comments.filter(
    (comment) =>
      !comment.createdByRunId &&
      (comment.authorType === "user" || comment.authorUserId),
  );
}

function oneOutput(checkpoint: ContextIntegrityCheckpoint, marker: string, requireMarker: boolean) {
  const outputs = checkpoint.documents.filter((document) =>
    !requireMarker || String(document.body ?? "").includes(marker),
  );
  return outputs.length === 1 ? outputs[0] : undefined;
}

function wakeCommentIds(run: Record<string, unknown>): string[] {
  const context = (run.contextSnapshot ?? {}) as Record<string, unknown>;
  const paperclipWake = (context.paperclipWake ?? {}) as Record<string, unknown>;
  const continuation = (context.executionContinuation ?? {}) as Record<string, unknown>;
  for (const candidate of [paperclipWake.commentIds, paperclipWake.wakeCommentIds, continuation.commentIds, continuation.wakeCommentIds]) {
    if (Array.isArray(candidate)) return candidate.map(String);
  }
  return [];
}

export function gradeContextIntegrity(input: {
  id: ContextIntegrityCase;
  marker: string;
  comments: readonly string[];
  checkpoints: readonly ContextIntegrityCheckpoint[];
}) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const initial = input.checkpoints.find((checkpoint) => checkpoint.phase === "initial");
  const final = input.checkpoints.find((checkpoint) => checkpoint.phase === "final");
  const finalComments = final ? userComments(final) : [];
  if (input.id === "ordered-comment-continuation") {
    const queued = input.checkpoints.find((checkpoint) => checkpoint.phase === "comment-3")?.queuedComments;
    const queuedEntries = Array.isArray(queued?.entries) ? queued.entries : [];
    const queuedRows = queuedEntries.map((entry) => {
      const comment = (entry as Record<string, unknown>).comment as Record<string, unknown> | undefined;
      return { id: String(comment?.id ?? ""), body: String(comment?.body ?? "") };
    });
    check("comments-queued-as-batch", queuedRows.length >= input.comments.length && input.comments.every((body, index) => queuedRows[index]?.body === body) && queuedRows.slice(0, input.comments.length).every((row) => Boolean(row.id)) && new Set(queuedRows.slice(0, input.comments.length).map((row) => row.id)).size === input.comments.length, "The three public comments must be present in one ordered deferred queue with distinct durable IDs before the initial run closes.");
    const initialUserComments = (initial?.comments ?? []).filter((comment) => !comment.createdByRunId && (comment.authorType === "user" || comment.authorUserId));
    check("initial-run-started", initial?.runs.some((run) => run.status === "running") === true && initialUserComments.length === 0, "The initial public run must be running before follow-up comments are submitted, with no follow-up user comments in the initial checkpoint.");
    check(
      "ordered-comments",
      input.comments.every((body, index) => finalComments[index] === body) && finalComments.length >= input.comments.length,
      "The three user comments must remain distinct and ordered, including the intentional repeated comment.",
    );
    const humanRows = final ? humanCommentRows(final) : [];
    const ids = humanRows.map((comment) => String(comment.id ?? ""));
    check(
      "distinct-comment-identities",
      ids.length === new Set(ids).size && ids.every(Boolean),
      "Each delivered user comment must retain its own durable identity, including repeated wording.",
    );
    check(
      "changed-scope-preserved",
      finalComments.at(2) === input.comments[2] && finalComments.at(0) === finalComments.at(1),
      "The final changed-scope comment must follow two identical earlier comments.",
    );
    const report = final?.documents.find((document) => /passport/i.test(String(document.body ?? "")) && /charger/i.test(String(document.body ?? "")));
    const body = String(report?.body ?? "");
    const orderedTerms = [input.comments[0], input.comments[1], input.comments[2]];
    let cursor = -1;
    const ordered = orderedTerms.every((term) => {
      const position = body.indexOf(term, cursor + 1);
      if (position < 0) return false;
      cursor = position + term.length - 1;
      return true;
    });
    check(
      "packing-report-order",
      /passport/i.test(body) && /charger/i.test(body) && ordered,
      "The durable packing report must retain both initial items and each verbatim request in order, including the repeated request and final scope.",
    );
    check(
      "final-scope-applied",
      ["launch checklist", "the launch checklist"].includes(
        body.match(/(?:^|\n)##[ \t]+Final scope[ \t]*\r?\n([\s\S]*?)(?=\n#{1,6}[ \t]+|$)/i)?.[1]?.trim().toLowerCase() ?? "",
      ),
      "The report must apply the final Launch checklist scope in a separate final-scope section outside the quoted request ledger.",
    );
    const succeededRunIds = (final?.runs ?? []).filter((run) => run.status === "succeeded").map((run) => String(run.id ?? "")).filter(Boolean);
    check("continuation-run-count", new Set(succeededRunIds).size === 2, "The initial run and one distinct successful deferred continuation run must both be recorded.");
    const continuation = (final?.runs ?? [])
      .filter((run) => run.status === "succeeded")
      .sort((a, b) => Date.parse(String(a.startedAt ?? "")) - Date.parse(String(b.startedAt ?? "")))[1];
    const expectedCommentIds = humanRows.slice(0, input.comments.length).map((comment) => String(comment.id ?? ""));
    check("continuation-wake-comment-ids", Boolean(continuation) && JSON.stringify(wakeCommentIds(continuation)) === JSON.stringify(expectedCommentIds), "The deferred continuation wake must carry all public comment IDs in arrival order.");
  }
  if (input.id === "assigned-skill-explicit-invocation") {
    const runtimeName = String(initial?.assignedSkill?.runtimeName ?? initial?.assignedSkill?.key ?? "");
    const requestText = String(initial?.skillRequestText ?? "");
    const references = requestText.split(/\s+/).map((word) => word.replace(/[.,]$/, ""));
    check("assigned-skill-present", Boolean(initial?.assignedSkill?.key && initial.assignedSkill.versionId), "The task run must receive one pinned skill version through the public assignment state.");
    check("skill-request-explicit", Boolean(runtimeName && references.some((word) => word === `/${runtimeName}` || word === `$${runtimeName}`)), "The task request must explicitly name the assigned skill with a supported slash or dollar reference.");
    check("skill-source-marker", Boolean(initial?.assignedSkill?.markdown?.includes(input.marker)), "The assigned pinned skill source must contain the output marker.");
    check("marker-not-in-request", !requestText.includes(input.marker) && !finalComments.some((comment) => comment.includes(input.marker)), "The output marker must originate from the assigned skill, not the task request or comments.");
  }
  const output = final ? oneOutput(final, input.marker, input.id === "assigned-skill-explicit-invocation") : undefined;
  check("single-durable-output", Boolean(output) && final!.documents.length === 1, input.id === "assigned-skill-explicit-invocation" ? "Exactly one durable task document must contain the skill's marker." : "Exactly one durable packing report document must be saved.");
  check("completed-task", final?.issue.status === "done", `Final task status: ${final?.issue.status ?? "missing"}.`);
  check("successful-runs", Boolean(final?.runs.length) && final!.runs.every((run) => run.status === "succeeded"), "All recorded context-integrity runs must succeed.");
  return checks;
}
