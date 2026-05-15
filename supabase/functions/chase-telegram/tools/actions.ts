import { escapeHtml, issueLink } from "../lib/html.ts";
import { paperclipGet, paperclipPost } from "../lib/api.ts";
import { cleanTaskTitle, cleanTaskDescription } from "./cleanup.ts";
import type { PaperclipAgent, PaperclipIssue, QueryResult } from "../types.ts";

const COMPANY_ID = Deno.env.get("PAPERCLIP_COMPANY_ID") ?? "";

export interface AgentInfo {
  id: string;
  display: string;
}

export async function resolveAgentByName(name: string): Promise<AgentInfo | null> {
  const agents = await paperclipGet<PaperclipAgent[]>(
    `/api/companies/${COMPANY_ID}/agents`,
  );
  const nameLower = name.toLowerCase();
  const agent = agents.find(
    (a) => a.name.toLowerCase().includes(nameLower),
  );
  if (agent) {
    return {
      id: agent.id,
      display: agent.title
        ? `${agent.name} — ${agent.title}`
        : agent.name,
    };
  }
  return null;
}

export async function handleCreateIssue(params: {
  title: string;
  description?: string;
  assigneeName?: string;
  sourceMessage?: string;
  confirmationMessage?: string;
  chatId?: number;
  originalDraftTitle?: string;
}): Promise<QueryResult> {
  // Hard confirmation gate: Telegram-originated creation requires confirmation metadata
  // This protects against classifier mistakes, regex errors, and future routing regressions.
  if (params.chatId && !params.sourceMessage) {
    return {
      text: "I can only create tasks when you confirm a task preview. Please describe the task and reply YES to confirm.",
    };
  }

  // Require an assignee when creating outside Telegram (LLM fallback path)
  if (!params.assigneeName && !params.chatId) {
    return {
      text: "I need to know who this task is for. Please include an agent name in your request.",
    };
  }

  let assigneeAgentId: string | undefined;
  let assigneeDisplay: string | undefined;
  let isUnassigned = false;

  if (params.assigneeName) {
    if (params.assigneeName === "UNASSIGNED") {
      isUnassigned = true;
      assigneeDisplay = "Unassigned";
    } else {
      const resolved = await resolveAgentByName(params.assigneeName);
      if (resolved) {
        assigneeAgentId = resolved.id;
        assigneeDisplay = resolved.display;
      } else {
        return {
          text: `I couldn't find an agent matching "${params.assigneeName}". Please check the name and try again.`,
        };
      }
    }
  }

  // Clean title and description
  const finalTitle = cleanTaskTitle(params.title, params.assigneeName);
  const finalDescription = cleanTaskDescription(params.description ?? "");

  const body: Record<string, unknown> = {
    title: finalTitle,
    description: finalDescription,
    priority: "medium",
    status: "todo",
  };
  if (assigneeAgentId) {
    body.assigneeAgentId = assigneeAgentId;
  }

  const issue = await paperclipPost<PaperclipIssue>(
    `/api/companies/${COMPANY_ID}/issues`,
    body,
  );

  // Enriched source/authorization note
  const sourceNoteLines: (string | null)[] = [
    `Created by Chase via Telegram.`,
    ``,
    `Requested by: Jeff`,
    params.sourceMessage ? `Source message: "${params.sourceMessage}"` : null,
    `Confirmed by Jeff: Yes`,
    params.confirmationMessage ? `Confirmation message: "${params.confirmationMessage}"` : null,
    isUnassigned ? `Assigned: Unassigned (explicitly opted in)` : `Assigned to: ${assigneeDisplay}`,
    `Created from Telegram at: ${new Date().toISOString()}`,
  ];

  const wasEdited = params.originalDraftTitle &&
    params.originalDraftTitle !== finalTitle;
  if (wasEdited) {
    sourceNoteLines.push(
      null,
      `Edited before creation: Yes`,
      `Original draft title: "${params.originalDraftTitle}"`,
      `Final title: "${finalTitle}"`,
    );
  }

  const sourceNote = sourceNoteLines.filter(Boolean).join("\n");

  await paperclipPost(
    `/api/companies/${COMPANY_ID}/issues/${issue.id}/comments`,
    { body: sourceNote },
  ).catch(() => {});

  const lines = [
    `<b>Issue Created</b>`,
    "",
    `${issueLink(issue.identifier)} — ${escapeHtml(finalTitle)}`,
  ];
  if (isUnassigned) {
    lines.push(`<b>Assignee:</b> Unassigned`);
  } else if (assigneeDisplay) {
    lines.push(`Assigned to: ${escapeHtml(assigneeDisplay)}`);
  }

  return { text: lines.join("\n") };
}
