import { sanitizeJson } from "./redaction.js";
import { questionReportAnswers } from "./interaction-report.js";
import { collectRunEvents } from "./run-observations.js";
import { taskChatProgress } from "./task-chat-progress.js";

type Row = Record<string, any>;
interface TaskChatRun {
  runId: string;
  agentId: string;
  runtimeMode?: "legacy" | "native";
}
export interface TaskChatMessage {
  id: string;
  at: string | null;
  role: "user" | "agent" | "system";
  author: string;
  kind: "description" | "comment" | "interaction" | "answer" | "progress";
  body: string;
}
export interface TaskChatThread {
  issueId: string;
  identifier: string | null;
  title: string;
  status: "complete" | "partial";
  messages: TaskChatMessage[];
}
export interface TaskChatEvidence {
  schema: "paperclip.runner-e2e.task-chat/v1";
  capturedAt: string;
  status: "complete" | "partial" | "unavailable";
  threads: TaskChatThread[];
  /** Fixed diagnostic labels only; API errors may contain private response bodies. */
  missing: string[];
}

const rows = (value: unknown): Row[] => {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("Invalid task chat page");
  }
  return value;
};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const at = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const lines = (values: unknown[]) => values.filter(value => typeof value === "string" && value.length).join("\n\n");

/** Only visible card copy and recorded choices cross the public boundary.
 * Tool arguments, credentials, provider envelopes and arbitrary metadata do not. */
function cardBody(row: Row): string {
  const p = row.payload ?? {};
  const questions = p.questionSet?.questions ?? p.questions ?? [];
  return lines([row.title, p.title, p.prompt, p.detailsMarkdown, p.questionSet?.title, p.questionSet?.description,
    ...rows(questions).map(q => lines([q.prompt, q.helpText,
      ...rows(q.options ?? []).map(option => lines([option.label, option.description])),
    ])),
    ...rows(p.items ?? p.options ?? []).map(item => lines([item.label, item.title, item.description])),
    p.acceptLabel, p.rejectLabel, `Status: ${text(row.status) || "unknown"}`]);
}
function answerBody(row: Row): string {
  const questions = rows(row.payload?.questionSet?.questions ?? row.payload?.questions ?? []);
  return lines([row.result?.outcome,
    ...questionReportAnswers({ ...row, id: text(row.id) }).map(answer => {
      const q = questions.find(q => q.id === answer.questionId);
      const selected = answer.optionIds ?? answer.selectedOptionIds ?? [];
      return lines([q?.prompt, ...(Array.isArray(selected) ? selected.map(id =>
        rows(q?.options ?? []).find(option => option.id === id)?.label ?? text(id)) : []),
      answer.otherText ?? answer.customText ?? answer.text]);
    }), row.result?.reason,
    ...(Array.isArray(row.result?.selectedOptionIds) ? row.result.selectedOptionIds.map((id: string) =>
      rows(row.payload?.items ?? row.payload?.options ?? []).find(item => item.id === id)?.label ?? id) : []),
    ...rows(row.result?.items ?? []).map(result => lines([
      rows(row.payload?.items ?? []).find(item => item.id === result.id)?.label ?? text(result.id),
      result.verdict, result.reason,
    ])),
  ]);
}

export function projectTaskChatThread(issue: Row, comments: Row[], interactions: Row[], names: ReadonlyMap<string, string>): TaskChatThread {
  const messages: TaskChatMessage[] = [];
  if (text(issue.description)) messages.push({ id: `description:${issue.id}`, at: at(issue.createdAt),
    role: "user", author: "Task brief", kind: "description", body: issue.description });
  for (const c of comments) {
    const role = c.authorAgentId || c.authorType === "agent" ? "agent" : c.authorType === "system" ? "system" : "user";
    messages.push({ id: `comment:${c.id}`, at: at(c.createdAt), role,
      author: role === "agent" ? names.get(c.authorAgentId) ?? "Agent" : role === "user" ? "You" : "System",
      kind: "comment", body: text(c.body) });
  }
  for (const card of interactions) {
    messages.push({ id: `interaction:${card.id}`, at: at(card.createdAt), role: "agent", author: "Request",
      kind: "interaction", body: cardBody(card) });
    if (card.result && card.resolvedAt) messages.push({ id: `answer:${card.id}`, at: at(card.resolvedAt),
      role: card.resolvedByAgentId ? "agent" : "user",
      author: card.resolvedByAgentId ? names.get(card.resolvedByAgentId) ?? "Agent" : "You",
      kind: "answer", body: answerBody(card) || text(card.status) });
  }
  messages.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
  return { issueId: text(issue.id), identifier: text(issue.identifier) || null, title: text(issue.title), status: "complete", messages };
}

/** Called once after run retirement and before the disposable instance is removed.
 * Discovery includes delegated tasks; explicit IDs retain standing chats even
 * when the journey has restored the disabled Agent Chat setting. */
export async function captureTaskChat(input: {
  get: <T>(route: string) => Promise<T>;
  companyId: string;
  issueIds?: readonly string[];
  secrets: readonly string[];
}): Promise<TaskChatEvidence> {
  const deadlineAt = Date.now() + 30_000;
  const get = <T>(route: string): Promise<T> => {
    if (Date.now() >= deadlineAt) return Promise.reject(new Error("Task chat collection deadline"));
    return input.get<T>(route);
  };
  const evidence: TaskChatEvidence = { schema: "paperclip.runner-e2e.task-chat/v1", capturedAt: new Date().toISOString(),
    status: "complete", threads: [], missing: [] };
  const issues = new Map<string, Row>();
  let names = new Map<string, string>();
  try {
    names = new Map(rows(await get(`/api/companies/${input.companyId}/agents`)).map(agent => [agent.id, text(agent.name) || "Agent"]));
  } catch { evidence.missing.push("agent-names"); }
  try {
    let cursor = "";
    for (let page = 0; ; page++) {
      if (page === 100) throw new Error("Task discovery exceeded page bound");
      const batch = rows(await get(`/api/companies/${input.companyId}/issues?includeAgentCreatedTasks=true&includeRoutineExecutions=true&includePluginOperations=true&sortField=id&sortDir=asc&limit=100${cursor ? `&afterId=${encodeURIComponent(cursor)}` : ""}`));
      if (batch.length > 100) throw new Error("Oversized task discovery page");
      for (const issue of batch) {
        if (!text(issue.id) || issue.id <= cursor || issues.has(issue.id) || issue.companyId !== input.companyId) throw new Error("Invalid task discovery page");
        issues.set(issue.id, issue);
        cursor = issue.id;
      }
      if (batch.length < 100) break;
    }
  } catch { evidence.missing.push("task-discovery"); }
  // Avoid a disabled-chat 404: the setting is often restored by the journey.
  try {
    const settings = await get<Row>("/api/instance/settings/experimental");
    if (settings.enableAgentChat) for (const issue of rows(await get(`/api/companies/${input.companyId}/chats`))) {
      if (issue.companyId !== input.companyId || !text(issue.id)) throw new Error("Foreign chat");
      issues.set(issue.id, issue);
    }
  } catch { evidence.missing.push("chat-discovery"); }
  for (const id of new Set(input.issueIds)) {
    if (issues.has(id)) continue;
    try {
      const issue = await get<Row>(`/api/issues/${encodeURIComponent(id)}`);
      if (issue.companyId !== input.companyId || issue.id !== id) throw new Error("Foreign task");
      issues.set(id, issue);
    } catch { evidence.missing.push("task-read"); }
  }
  for (const issue of issues.values()) {
    const comments: Row[] = [];
    let interactions: Row[] = [];
    let complete = true;
    try {
      let cursor = "";
      const seen = new Set<string>();
      for (let page = 0; ; page++) {
        if (page === 100) throw new Error("Comment capture exceeded page bound");
        const batch = rows(await get(`/api/issues/${issue.id}/comments?order=asc&limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`));
        if (batch.length > 100) throw new Error("Oversized comment page");
        for (const comment of batch) {
          if (!text(comment.id) || seen.has(comment.id)) throw new Error("Repeated comment page");
          seen.add(comment.id); comments.push(comment); cursor = comment.id;
        }
        if (batch.length < 100) break;
      }
    } catch { complete = false; evidence.missing.push("comments"); }
    try { interactions = rows(await get(`/api/issues/${issue.id}/interactions`)); }
    catch { complete = false; evidence.missing.push("interactions"); }
    try {
      const thread = projectTaskChatThread(issue, comments, interactions, names);
      try {
        const runs = await get<TaskChatRun[]>(`/api/issues/${issue.id}/runs`);
        rows(runs);
        for (const run of runs.filter(run => run.runtimeMode === "native")) {
          if (!text(run.runId)) throw new Error("Native task run has no runId");
          const events = await collectRunEvents((afterSeq, limit) => get(`/api/heartbeat-runs/${encodeURIComponent(run.runId)}/events?afterSeq=${afterSeq}&limit=${limit}`));
          thread.messages.push(...taskChatProgress(run.runId, events, names.get(run.agentId) ?? "Agent"));
        }
        thread.messages.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
      } catch { complete = false; evidence.missing.push("progress"); }
      thread.status = complete ? "complete" : "partial";
      evidence.threads.push(thread);
    } catch { evidence.missing.push("thread-projection"); }
  }
  evidence.missing = [...new Set(evidence.missing)];
  if (evidence.missing.length) evidence.status = evidence.threads.length ? "partial" : "unavailable";
  return sanitizeJson(evidence, input.secrets) as TaskChatEvidence;
}
