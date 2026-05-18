import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { documents, issueDocuments, issues } from "@paperclipai/db";
import { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY } from "@paperclipai/shared";
import { documentService } from "./documents.js";

export { ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY };
export const ISSUE_CONTINUATION_SUMMARY_TITLE = "Continuation Summary";
export const ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS = 8_000;
const SUMMARY_SECTION_MAX_CHARS = 1_200;
const PATH_CANDIDATE_RE = /(?:^|[\s`"'(])((?:server|ui|packages|doc|scripts|\.github)\/[A-Za-z0-9._/-]+)/g;
const WAITING_FOR_REVIEW_OR_APPROVAL_RE =
  /\bwait(?:ing)? for\b.{0,160}\b(?:review(?:er)?(?: feedback)?|approval|board|human|user|operator)\b/i;

type IssueSummaryInput = {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
};

type RunSummaryInput = {
  id: string;
  status: string;
  error: string | null;
  errorCode?: string | null;
  resultJson?: Record<string, unknown> | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  finishedAt?: Date | null;
};

type AgentSummaryInput = {
  id: string;
  name: string;
  adapterType: string | null;
};

export type IssueContinuationSummaryDocument = {
  key: typeof ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY;
  title: string | null;
  body: string;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  updatedAt: Date;
};

function truncateText(value: string, maxChars: number) {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 20)).trimEnd()}\n[truncated]`;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readResultSummary(resultJson: Record<string, unknown> | null | undefined) {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  return (
    asNonEmptyString(resultJson.summary) ??
    asNonEmptyString(resultJson.result) ??
    asNonEmptyString(resultJson.message) ??
    asNonEmptyString(resultJson.error) ??
    null
  );
}

function extractMarkdownSection(markdown: string | null | undefined, heading: string) {
  if (!markdown) return null;
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, "im");
  const match = re.exec(markdown);
  const section = match?.[1]?.trim();
  return section ? truncateText(section, SUMMARY_SECTION_MAX_CHARS) : null;
}

function extractPathCandidates(...texts: Array<string | null | undefined>) {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(PATH_CANDIDATE_RE)) {
      const path = match[1]?.replace(/[),.;:]+$/, "");
      if (path) seen.add(path);
      if (seen.size >= 12) break;
    }
    if (seen.size >= 12) break;
  }
  return [...seen];
}

function inferMode(issue: IssueSummaryInput, run: RunSummaryInput) {
  if (issue.status === "done" || issue.status === "in_review") return "review";
  if (run.status === "failed" || run.status === "timed_out" || run.status === "cancelled") return "implementation";
  if (issue.status === "backlog" || issue.status === "todo") return "plan";
  return "implementation";
}

function inferNextAction(issue: IssueSummaryInput, run: RunSummaryInput, previousNextAction: string | null) {
  if (issue.status === "done") return "Review the completed issue output and close any remaining follow-up comments.";
  if (issue.status === "in_review") return "Wait for reviewer feedback or approval before continuing executor work.";
  if (run.status === "failed" || run.status === "timed_out") {
    return "Inspect the failed run, fix the cause, and resume from the most recent concrete action above.";
  }
  if (run.status === "cancelled") return "Confirm the cancellation reason before starting another run.";
  return previousNextAction ?? "Resume implementation from the acceptance criteria, latest comments, and this summary.";
}

function bulletList(items: string[], empty: string) {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item}`).join("\n");
}

function extractPreviousNextAction(previousBody: string | null | undefined) {
  const section = extractMarkdownSection(previousBody, "Next Action");
  if (!section) return null;
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .find(Boolean) ?? null;
}

export function extractContinuationSummaryNextAction(body: string | null | undefined) {
  return extractPreviousNextAction(body);
}

export function continuationSummaryParksExecutor(body: string | null | undefined) {
  const nextAction = extractContinuationSummaryNextAction(body);
  if (!nextAction) return false;
  return WAITING_FOR_REVIEW_OR_APPROVAL_RE.test(nextAction);
}

export function buildContinuationSummaryMarkdown(input: {
  issue: IssueSummaryInput;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
  previousSummaryBody?: string | null;
}) {
  const { issue, run, agent } = input;
  const resultSummary = readResultSummary(run.resultJson);
  const recentActions = [
    `Run \`${run.id}\` finished with status \`${run.status}\`${run.finishedAt ? ` at ${run.finishedAt.toISOString()}` : ""}.`,
    resultSummary ? truncateText(resultSummary, SUMMARY_SECTION_MAX_CHARS) : "No adapter-provided result summary was captured for this run.",
  ];
  if (run.error) {
    recentActions.push(`Latest run error${run.errorCode ? ` (${run.errorCode})` : ""}: ${truncateText(run.error, 500)}`);
  }

  const paths = extractPathCandidates(resultSummary, run.stdoutExcerpt, run.stderrExcerpt, input.previousSummaryBody);
  const objective = extractMarkdownSection(issue.description, "Objective") ?? issue.description?.trim() ?? "No objective captured.";
  const acceptanceCriteria = extractMarkdownSection(issue.description, "Acceptance Criteria") ?? "No explicit acceptance criteria captured.";
  const mode = inferMode(issue, run);
  const nextAction = inferNextAction(issue, run, extractPreviousNextAction(input.previousSummaryBody));

  const body = [
    "# Continuation Summary",
    "",
    `- Issue: ${issue.identifier ?? issue.id} — ${issue.title}`,
    `- Status: ${issue.status}`,
    `- Priority: ${issue.priority}`,
    `- Current mode: ${mode}`,
    `- Last updated by run: ${run.id}`,
    `- Agent: ${agent.name} (${agent.adapterType ?? "unknown"})`,
    "",
    "## Objective",
    "",
    truncateText(objective, SUMMARY_SECTION_MAX_CHARS),
    "",
    "## Acceptance Criteria",
    "",
    acceptanceCriteria,
    "",
    "## Recent Concrete Actions",
    "",
    bulletList(recentActions, "No recent actions captured."),
    "",
    "## Files / Routes Touched",
    "",
    bulletList(paths.map((path) => `\`${path}\``), "No file or route paths were detected in the captured run summary."),
    "",
    "## Commands Run",
    "",
    bulletList(
      [
        `Heartbeat run \`${run.id}\` invoked adapter \`${agent.adapterType ?? "unknown"}\`.`,
        "Detailed shell/tool commands remain in the run log and transcript.",
      ],
      "No command metadata captured.",
    ),
    "",
    "## Blockers / Decisions",
    "",
    bulletList(
      run.error
        ? [`Latest run ended with \`${run.status}\`; inspect the error before continuing.`]
        : ["No new blocker was recorded by the latest run."],
      "No blockers or decisions captured.",
    ),
    "",
    "## Next Action",
    "",
    `- ${nextAction}`,
  ].join("\n");

  return truncateText(body, ISSUE_CONTINUATION_SUMMARY_MAX_BODY_CHARS);
}

export async function getIssueContinuationSummaryDocument(
  db: Db,
  issueId: string,
): Promise<IssueContinuationSummaryDocument | null> {
  const row = await db
    .select({
      key: issueDocuments.key,
      title: documents.title,
      body: documents.latestBody,
      latestRevisionId: documents.latestRevisionId,
      latestRevisionNumber: documents.latestRevisionNumber,
      updatedAt: documents.updatedAt,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY)))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return {
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: row.title,
    body: row.body,
    latestRevisionId: row.latestRevisionId,
    latestRevisionNumber: row.latestRevisionNumber,
    updatedAt: row.updatedAt,
  };
}

export async function refreshIssueContinuationSummary(input: {
  db: Db;
  issueId: string;
  run: RunSummaryInput;
  agent: AgentSummaryInput;
}) {
  const { db, issueId, run, agent } = input;
  const [issue, existing] = await Promise.all([
    db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        title: issues.title,
        description: issues.description,
        status: issues.status,
        priority: issues.priority,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null),
    getIssueContinuationSummaryDocument(db, issueId),
  ]);

  if (!issue) return null;
  const body = buildContinuationSummaryMarkdown({
    issue,
    run,
    agent,
    previousSummaryBody: existing?.body ?? null,
  });
  const result = await documentService(db).upsertIssueDocument({
    issueId,
    key: ISSUE_CONTINUATION_SUMMARY_DOCUMENT_KEY,
    title: ISSUE_CONTINUATION_SUMMARY_TITLE,
    format: "markdown",
    body,
    baseRevisionId: existing?.latestRevisionId ?? null,
    changeSummary: `Refresh continuation summary after run ${run.id}`,
    createdByAgentId: agent.id,
    createdByRunId: run.id,
  });
  return result.document;
}
