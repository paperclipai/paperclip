import {
  interactionReportTitle,
  questionReportAnswers,
  renderInteractionCard,
} from "./interaction-report.js";
import {
  digestText,
  type FirstTaskEvidence,
  type Row,
} from "./first-task-scoring.js";

const html = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export interface TranscriptEntry {
  id: string;
  kind: "comment" | "interaction" | "answer" | "document" | "attachment" | "run";
  at: string;
  checkpoint: string;
  row: Row;
}
/** Repeated API snapshots are observations, not additional chat messages. Keep
 * the latest comment/card state and every observed document revision. */
export function firstTaskTranscript(e: FirstTaskEvidence): TranscriptEntry[] {
  const entries = new Map<string, TranscriptEntry>();
  for (const checkpoint of e.checkpoints) {
    for (const [kind, rows] of [
      ["comment", checkpoint.comments],
      ["interaction", checkpoint.interactions],
      ["document", checkpoint.documents],
      ["attachment", checkpoint.attachments ?? []],
      ["run", checkpoint.runs],
    ] as const) {
      for (const row of rows) {
        const revision =
          kind === "document"
            ? `:${row.latestRevisionId ?? row.revisionId ?? digestText(String(row.body ?? ""))}`
            : "";
        const id = `${kind}:${row.issueId ?? ""}:${row.id ?? row.key}${revision}`;
        entries.set(id, {
          id,
          kind,
          at:
            kind === "run"
              ? (row.startedAt ??
                row.createdAt ??
                entries.get(id)?.at ??
                checkpoint.at)
              : kind === "document"
                ? (row.updatedAt ??
                  row.createdAt ??
                  entries.get(id)?.at ??
                  checkpoint.at)
                : (row.createdAt ?? entries.get(id)?.at ?? checkpoint.at),
          checkpoint: checkpoint.id,
          row,
        });
        if (kind === "interaction" && row.result && row.resolvedAt) {
          entries.set(`answer:${row.id}`, {
            id: `answer:${row.id}`,
            kind: "answer",
            at: row.resolvedAt,
            checkpoint: checkpoint.id,
            row,
          });
        }
      }
    }
  }
  return [...entries.values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );
}
const body = (value: unknown) =>
  `<div class="transcript-text">${html(value)}</div>`;
const raw = (value: unknown, title: string) =>
  `<details class="transcript-raw"><summary>${html(title)}</summary><pre>${html(JSON.stringify(value, null, 2))}</pre></details>`;
export function renderFirstTaskTranscript(
  e: FirstTaskEvidence,
  checkpointHref: (id: string) => string,
) {
  const names = new Map(
    e.checkpoints.flatMap((c) =>
      c.agents.map((a) => [a.id, a.name ?? a.id] as const),
    ),
  );
  const entries = firstTaskTranscript(e);
  return `<section class="transcript" aria-label="Recorded conversation">
    <details class="transcript-about"><summary>About this recording</summary><p class="detail">Recorded conversation: comments, question and approval cards, answers, observed document revisions, and saved attachments. Repeated checkpoints are deduplicated. Cards reconstruct saved prompts and recorded selections; multi-question forms are expanded for review. Run metadata is expandable; raw tool events are available through the evidence links. This is retained evidence, not a live task. Only messages and document revisions captured at checkpoints are available; messages from other tasks may not be included.</p></details>
    ${
      entries
        .map((entry) => {
          const row = entry.row;
          let title: string;
          let content: string;
          if (entry.kind === "comment") {
            title = row.authorAgentId
              ? `Agent · ${names.get(row.authorAgentId) ?? row.authorAgentId}`
              : "User";
            content = body(row.body);
          } else if (entry.kind === "interaction") {
            title = interactionReportTitle(row);
            content = renderInteractionCard(row, names);
          } else if (entry.kind === "answer") {
            title = row.resolvedByAgentId
              ? "Agent card response"
              : "User card response";
            const answers = questionReportAnswers(row);
            const questions =
              row.payload?.questionSet?.questions ??
              row.payload?.questions ??
              [];
            content = answers.length
              ? answers
                  .map((a: Row) => {
                    const question = questions.find(
                      (q: Row) => q.id === a.questionId,
                    );
                    const options = (
                      a.optionIds ??
                      a.selectedOptionIds ??
                      []
                    ).map(
                      (id: string) =>
                        question?.options?.find((o: Row) => o.id === id)
                          ?.label ?? id,
                    );
                    return (
                      body(question?.prompt ?? a.questionId) +
                      body(
                        [
                          ...options,
                          a.otherText ?? a.customText ?? a.text ?? "",
                        ]
                          .filter(Boolean)
                          .join("\n"),
                      )
                    );
                  })
                  .join("")
              : body(row.result.outcome ?? row.status) +
                (row.result.reason ? body(row.result.reason) : "");
            content += raw(row.result, "Recorded answer");
          } else if (entry.kind === "attachment") {
            title = `Attachment · ${row.title ?? row.originalFilename ?? row.filename ?? row.id}`;
            content = row.contentVerified ? body(row.body) : "<p>Attachment recorded; text content unavailable.</p>";
            content += raw(row, "Saved attachment evidence");
          } else if (entry.kind === "document") {
            title = `Document · ${row.title ?? row.key} · revision ${row.latestRevisionNumber ?? row.revisionNumber ?? "unreported"}`;
            content = body(row.body);
          } else {
            title = `Agent run · ${row.status}`;
            content = raw(row, `Run ${row.id} · metadata and usage`);
          }
          const authorId =
            entry.kind === "comment"
              ? row.authorAgentId
              : row.resolvedByAgentId;
          const presentation =
            entry.kind === "comment" || entry.kind === "answer"
              ? authorId
                ? "agent"
                : "human"
              : entry.kind === "run"
                ? "event"
                : "card";
          const agentName = String(names.get(authorId) ?? "Agent");
          const initials = agentName
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((part) => part[0])
            .join("")
            .toUpperCase();
          const time = Number.isFinite(Date.parse(entry.at))
            ? `${new Date(entry.at).toISOString().slice(11, 19)} UTC`
            : entry.at;
          return `<article class="transcript-entry transcript-${entry.kind} transcript-${presentation}"><header>${presentation === "agent" ? `<span class="transcript-avatar" aria-hidden="true">${html(initials)}</span>` : ""}<strong>${html(title)}</strong></header><div class="transcript-bubble">${content}</div><footer><time datetime="${html(entry.at)}" title="${html(entry.at)}">${html(time)}</time><a href="${html(checkpointHref(entry.checkpoint))}">Source checkpoint</a>${row.issueId ? `<details class="transcript-task"><summary>Task</summary><code>${html(row.issueId)}</code></details>` : ""}</footer></article>`;
        })
        .join("") || "<p>No conversation was recorded before the failure.</p>"
    }
  </section>`;
}
