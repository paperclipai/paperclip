import { escapeHtml, issueLink } from "../lib/html.ts";
import { paperclipGet, paperclipPost } from "../lib/api.ts";
import { cleanTaskTitle, cleanTaskDescription } from "./cleanup.ts";
import { clearPendingTask } from "../lib/pending-tasks.ts";
import type { PaperclipAgent, PaperclipIssue, QueryResult } from "../types.ts";

const COMPANY_ID = Deno.env.get("PAPERCLIP_COMPANY_ID") ?? "";

export interface AgentInfo {
  id: string;
  display: string;
}

export function formatActionName(action: string): string {
  const names: Record<string, string> = {
    delete: "Delete",
    close: "Close",
    cancel: "Cancel",
    mark_done: "Mark as done",
    archive: "Archive",
    remove: "Delete",
  };
  return names[action] ?? action.charAt(0).toUpperCase() + action.slice(1);
}

export async function lookupIssue(identifier: string): Promise<PaperclipIssue | null> {
  const resolvedId = /^\d+$/.test(identifier) ? `CRE-${identifier}` : identifier;
  const issues = await paperclipGet<PaperclipIssue[]>(
    `/api/companies/${COMPANY_ID}/issues?q=${encodeURIComponent(resolvedId)}&limit=5`,
  );
  const match = issues.find(
    (i) => i.identifier.toUpperCase() === resolvedId.toUpperCase(),
  );
  if (!match) return null;
  return paperclipGet<PaperclipIssue>(`/api/issues/${match.id}`);
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
  sourceIssueId?: string;
  sourceIssueIdentifier?: string;
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
      try {
        const resolved = await resolveAgentByName(params.assigneeName);
        if (resolved) {
          assigneeAgentId = resolved.id;
          assigneeDisplay = resolved.display;
        } else {
          return {
            text: `I couldn't find an agent matching "${params.assigneeName}". Please check the name and try again.`,
          };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`Agent resolution failed: ${message}`);
        return {
          text: "I had trouble looking up agents. Please try again shortly.",
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

  // Create the issue with permission-aware error handling
  let issue: PaperclipIssue;
  try {
    issue = await paperclipPost<PaperclipIssue>(
      `/api/companies/${COMPANY_ID}/issues`,
      body,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Issue creation failed: ${message}`);
    // Detect permission-denied errors from the Paperclip server
    if (message.includes("403") ||
        message.includes("Missing permission") ||
        message.includes("tasks:assign")) {
      return {
        text: "I'm unable to create tasks right now \u2014 the Chase agent doesn't have the \u201ctasks:assign\u201d permission. A board admin needs to grant it.",
      };
    }
    return {
      text: "I ran into a problem creating the task. Please try again or contact an admin.",
    };
  }

  // Clear the pending task only after successful creation
  if (params.chatId) {
    await clearPendingTask(params.chatId);
  }

  // Enriched source/authorization note
  const sourceNoteLines: (string | null)[] = [
    `Created by Chase via Telegram.`,
    ``,
    `Requested by: Jeff`,
    params.sourceMessage ? `Source message: "${params.sourceMessage}"` : null,
    `Confirmed by Jeff: Yes`,
    params.confirmationMessage ? `Confirmation message: "${params.confirmationMessage}"` : null,
    isUnassigned ? `Assigned: Unassigned (explicitly opted in)` : `Assigned to: ${assigneeDisplay}`,
    params.sourceIssueIdentifier ? `Related task: ${params.sourceIssueIdentifier}` : null,
    params.sourceIssueIdentifier ? `Reason: Jeff requested action on ${params.sourceIssueIdentifier} via Telegram.` : null,
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

  try {
    await paperclipPost(
      `/api/companies/${COMPANY_ID}/issues/${issue.id}/comments`,
      { body: sourceNote },
    );
  } catch (err) {
    // Log audit trail failures but do not fail the operation
    console.error(
      `Audit comment failed for ${issue.identifier ?? issue.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Cross-reference comment on the original issue when delegating about an existing task
  if (params.sourceIssueId && params.sourceIssueIdentifier) {
    try {
      await paperclipPost(
        `/api/companies/${COMPANY_ID}/issues/${params.sourceIssueId}/comments`,
        {
          body: [
            `Chase received a Telegram request from Jeff regarding this task.`,
            `Related task created: ${issueLink(issue.identifier)}`,
            `Assigned to: ${assigneeDisplay ?? "Unassigned"}`,
            `Reason: Jeff requested via Telegram.`,
            `Timestamp: ${new Date().toISOString()}`,
          ].join("\n"),
        },
      );
    } catch (err) {
      console.error(
        `Cross-reference comment failed for ${params.sourceIssueId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

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
